import { Context, Effect, Layer, Predicate, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http"
import { DataHolderBrand, ProductDetail, ProductsPage, RegisterResponse, type ProductSummary } from "./schema.ts"

const REGISTER_URL = "https://api.cdr.gov.au/cdr-register/v1/all/data-holders/brands/summary"

// Industries whose data holders publish banking product APIs.
const LENDING_INDUSTRIES = new Set(["banking", "non-bank-lending"])

// Highest endpoint versions we will ask for. Data holders reply with the
// highest version they support between x-min-v and x-v.
const PRODUCTS_MAX_VERSION = 6
const PRODUCT_DETAIL_MAX_VERSION = 8

export class CdrError extends Schema.TaggedError<CdrError>()("CdrError", {
  url: Schema.String,
  status: Schema.optional(Schema.Number),
  message: Schema.String
}) {}

// Westpac group's CloudFront caches a response per Accept/Accept-Encoding
// combination, and some of those copies are stale and list no products.
// Which combination is broken varies by brand and over time, so callers that
// expect products can retry the listing with another variant.
export const REQUEST_VARIANTS: ReadonlyArray<Readonly<Record<string, string>>> = [
  { accept: "application/json", "accept-encoding": "identity" },
  { accept: "application/json", "accept-encoding": "gzip" },
  { accept: "*/*", "accept-encoding": "identity" },
  { accept: "*/*", "accept-encoding": "gzip" }
]

export interface VersionedProduct {
  readonly version: number
  readonly raw: unknown
  readonly detail: ProductDetail
}

export class CdrClient extends Context.Service<
  CdrClient,
  {
    readonly brands: Effect.Effect<ReadonlyArray<DataHolderBrand>, CdrError>
    listProducts(
      baseUri: string,
      category: string,
      variant?: number
    ): Effect.Effect<ReadonlyArray<ProductSummary>, CdrError>
    getProduct(baseUri: string, productId: string): Effect.Effect<VersionedProduct, CdrError>
  }
>()("creditcards/cdr/CdrClient") {
  static readonly layer = Layer.effect(
    CdrClient,
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.retryTransient({ schedule: Schedule.exponential("500 millis"), times: 2 })
      )

      // GET with CDR version negotiation. Not every data holder honours
      // x-min-v, so on a 406 fall back to probing each version downwards.
      const getVersioned = Effect.fn("CdrClient.getVersioned")(function* (
        url: string,
        maxVersion: number,
        variant = 0
      ) {
        const attempt = (headers: Record<string, string>) =>
          client.get(url, { headers: { ...REQUEST_VARIANTS[variant % REQUEST_VARIANTS.length], ...headers } }).pipe(
            Effect.timeout("20 seconds"),
            Effect.mapError((cause) => new CdrError({ url, message: String(cause) }))
          )

        let response = yield* attempt({ "x-v": String(maxVersion), "x-min-v": "1" })

        for (let v = maxVersion; response.status === 406 && v >= 1; v--) {
          response = yield* attempt({ "x-v": String(v) })
        }

        if (response.status !== 200) {
          return yield* new CdrError({ url, status: response.status, message: `HTTP ${response.status}` })
        }

        const body = yield* response.json.pipe(
          Effect.mapError((cause) => new CdrError({ url, message: `Invalid JSON: ${String(cause)}` }))
        )

        const version = Number(response.headers["x-v"] ?? NaN)

        return { body, version }
      })

      const schemaError = (url: string) => (error: Schema.SchemaError) =>
        new CdrError({ url, message: `Schema: ${error.message}` })

      const brands = Effect.gen(function* () {
        const response = yield* client.get(REGISTER_URL, { headers: { "x-v": "2" } }).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(RegisterResponse)),
          Effect.mapError((cause) => new CdrError({ url: REGISTER_URL, message: String(cause) }))
        )

        return response.data.filter((brand) => brand.industries.some((i) => LENDING_INDUSTRIES.has(i)))
      }).pipe(Effect.withSpan("CdrClient.brands"))

      const listProducts = Effect.fn("CdrClient.listProducts")(function* (
        baseUri: string,
        category: string,
        variant = 0
      ) {
        const products: Array<ProductSummary> = []
        // Fetch unfiltered and filter locally: some data holders mishandle
        // product-category (e.g. Westpac returns nothing when it is combined
        // with page-size).
        let url: string | null | undefined = `${trimSlash(baseUri)}/cds-au/v1/banking/products?page-size=100`

        for (let page = 0; url != null && url !== "" && page < 20; page++) {
          const { body }: { body: unknown } = yield* getVersioned(url, PRODUCTS_MAX_VERSION, variant)

          const decoded: typeof ProductsPage.Type = yield* decodeProductsPage(body).pipe(
            Effect.mapError(schemaError(url))
          )

          products.push(...decoded.data.products.filter((p) => p.productCategory === category))
          const next: string | null | undefined = decoded.links?.next
          url = next != null && next !== "" && next !== url ? next : undefined
        }

        return products
      })

      const getProduct = Effect.fn("CdrClient.getProduct")(function* (baseUri: string, productId: string) {
        const url = `${trimSlash(baseUri)}/cds-au/v1/banking/products/${encodeURIComponent(productId)}`
        const { body, version } = yield* getVersioned(url, PRODUCT_DETAIL_MAX_VERSION)
        const raw = Predicate.isObject(body) ? body["data"] : undefined
        const detail = yield* decodeProductDetail(raw).pipe(Effect.mapError(schemaError(url)))

        return { version, raw, detail }
      })

      return CdrClient.of({ brands, listProducts, getProduct })
    })
  ).pipe(Layer.provide(FetchHttpClient.layer))
}

const decodeProductsPage = Schema.decodeUnknownEffect(ProductsPage)
const decodeProductDetail = Schema.decodeUnknownEffect(ProductDetail)

const trimSlash = (uri: string) => uri.replace(/\/+$/u, "")
