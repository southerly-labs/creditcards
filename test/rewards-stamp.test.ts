import { BunServices } from "@effect/platform-bun"
import { assert, describe, layer } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path } from "effect"
import { Digest } from "effect/crypto"
import { CdrClient, CdrError } from "../src/cdr/CdrClient.ts"
import { DataHolderBrand } from "../src/cdr/schema.ts"
import { initialLifecycle } from "../src/machine/cardLifecycle.ts"
import { loyaltyTextHash } from "../src/rewards/parse.ts"
import { stamp } from "../src/rewards/review.ts"
import { Store } from "../src/store/Store.ts"
import { required } from "../src/util/required.ts"

const BASE_URI = "https://cdr.bank.example"

const loyalty = [
  { featureType: "LOYALTY_PROGRAM", additionalValue: "Points", additionalInfo: "Earn points on everything" }
]

const FakeCdr = Layer.succeed(
  CdrClient,
  CdrClient.of({
    brands: Effect.succeed([
      DataHolderBrand.make({ brandName: "Bank", industries: ["banking"], publicBaseUri: BASE_URI })
    ]),
    listProducts: () => Effect.fail(CdrError.make({ url: BASE_URI, message: "unused" })),
    getProduct: (_baseUri, productId) => {
      const detail = { productId, name: "Card", productCategory: "CRED_AND_CHRG_CARDS", features: loyalty }

      return Effect.succeed({ version: 4, raw: detail, detail })
    }
  })
)

const TempStore = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    return Store.layer(path.join(yield* fs.makeTempDirectoryScoped(), "data"))
  })
)

const Env = Layer.mergeAll(TempStore, FakeCdr, Digest.layerWebCrypto).pipe(Layer.provideMerge(BunServices.layer))

const seed = Effect.gen(function* () {
  const store = yield* Store
  yield* store.writeIssuer("bank", { name: "Bank", cdr_brands: ["Bank"] })
  yield* store.writeCard("bank", "card", {
    name: "Card",
    type: "personal",
    first_seen: "2026-11-01",
    lifecycle: initialLifecycle,
    cdr: { brand: "Bank", product_id: "p1" },
    fees: {},
    rates: {},
    limits: {},
    perks: {},
    rewards: { program: "points" }
  })
})

const earnState = Effect.gen(function* () {
  return required((yield* (yield* Store).load).cards.get("bank/card")).earn_state
})

describe("rewards stamp", () => {
  layer(Env, { buildPerTest: true })((it) => {
    it.effect("stamps when the pinned hash matches the current CDR text", () =>
      Effect.gen(function* () {
        yield* seed
        const hash = yield* loyaltyTextHash(loyalty)
        yield* stamp([`bank/card@${hash}`], true)

        assert.strictEqual((yield* earnState)?._tag, "Reviewed")
      })
    )

    it.effect("refuses and writes nothing when the CDR text changed since it was listed", () =>
      Effect.gen(function* () {
        yield* seed
        const error = yield* Effect.flip(stamp(["bank/card@0123456789abcdef"], true))

        assert.include(error.message, "the CDR text changed since it was listed")
        assert.isUndefined(yield* earnState)
      })
    )
  })
})
