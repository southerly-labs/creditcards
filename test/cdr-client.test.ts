import { assert, describe, layer } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { CdrClient } from "../src/cdr/CdrClient.ts"

const BASE = "https://cdr.bank.example"

const page = (products: ReadonlyArray<{ readonly id: string; readonly category: string }>) =>
  Response.json({
    data: {
      products: products.map((p) => ({ productId: p.id, name: p.id, productCategory: p.category }))
    }
  })

const mixed = [
  { id: "card", category: "CRED_AND_CHRG_CARDS" },
  { id: "loan", category: "PERS_LOANS" }
]

const requests: Array<string> = []
let hangFirst = false

const reply = (request: Parameters<Parameters<typeof HttpClient.make>[0]>[0], url: URL) =>
  HttpClientResponse.fromWeb(
    request,
    url.hostname === "reject.example" && url.searchParams.has("product-category")
      ? new Response("bad request", { status: 400 })
      : page(mixed)
  )

const respond = Effect.fn("respond")(function* (
  request: Parameters<Parameters<typeof HttpClient.make>[0]>[0],
  url: URL
) {
  requests.push(url.toString())

  if (hangFirst && requests.length === 1) yield* Deferred.await(Deferred.makeUnsafe<void>())

  return reply(request, url)
})

const TestCdr = CdrClient.layerNoDeps.pipe(
  Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(respond)))
)

const reset = (hang = false) =>
  Effect.sync(() => {
    requests.length = 0
    hangFirst = hang
  })

describe("CdrClient.listProducts", () => {
  layer(TestCdr)((it) => {
    it.effect("asks for the category and still filters the response", () =>
      Effect.gen(function* () {
        yield* reset()
        const cdr = yield* CdrClient
        const products = yield* cdr.listProducts(BASE, "CRED_AND_CHRG_CARDS")

        assert.deepStrictEqual(
          products.map((p) => p.productId),
          ["card"]
        )
        assert.deepStrictEqual(requests, [
          `${BASE}/cds-au/v1/banking/products?product-category=CRED_AND_CHRG_CARDS&page-size=100`
        ])
      })
    )

    it.effect("lists every product when a holder rejects the category parameter", () =>
      Effect.gen(function* () {
        yield* reset()
        const cdr = yield* CdrClient
        const products = yield* cdr.listProducts("https://reject.example", "CRED_AND_CHRG_CARDS")

        assert.deepStrictEqual(
          products.map((p) => p.productId),
          ["card"]
        )
        assert.strictEqual(requests.at(-1), "https://reject.example/cds-au/v1/banking/products?page-size=100")
      })
    )

    it.effect("times out a hung request and retries it", () =>
      Effect.gen(function* () {
        yield* reset(true)
        const cdr = yield* CdrClient
        const fiber = yield* cdr.listProducts(BASE, "CRED_AND_CHRG_CARDS").pipe(Effect.forkChild)
        yield* TestClock.adjust("25 seconds")
        const products = yield* Fiber.join(fiber)

        assert.deepStrictEqual(
          products.map((p) => p.productId),
          ["card"]
        )
        assert.strictEqual(requests.length, 2)
      })
    )
  })
})
