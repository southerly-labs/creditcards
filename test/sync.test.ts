import { BunServices } from "@effect/platform-bun"
import { assert, describe, layer } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer, Path, Ref } from "effect"
import { TestClock } from "effect/testing"
import { CdrClient, CdrError } from "../src/cdr/CdrClient.ts"
import { DataHolderBrand, type ProductDetail } from "../src/cdr/schema.ts"
import { Snapshots } from "../src/history/Snapshots.ts"
import { Store } from "../src/store/Store.ts"
import { syncCdr } from "../src/sync/Sync.ts"
import { required } from "../src/util/required.ts"

const BASE_URI = "https://cdr.bank.example"

const product = (productId: string, annual: string): ProductDetail => ({
  productId,
  name: `Card ${productId}`,
  productCategory: "CRED_AND_CHRG_CARDS",
  fees: [
    { name: "Annual fee", feeType: "PERIODIC", fixedAmount: { amount: annual }, additionalValue: "P1Y" },
    { name: "Late payment fee", feeType: "LATE_PAYMENT", fixedAmount: { amount: "15.00" } },
    { name: "Foreign transaction fee", feeType: "TRANSACTION", rateBased: { rate: "0.03" } }
  ],
  lendingRates: [{ lendingRateType: "PURCHASE", rate: "0.1999" }]
})

interface WorldState {
  readonly products: ReadonlyArray<ProductDetail>
  readonly failing: ReadonlySet<string>
}

const seeded: WorldState = {
  products: ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10"].map((id) => product(id, "99.00")),
  failing: new Set()
}

class World extends Context.Service<World, Ref.Ref<WorldState>>()("test/World") {}

const findProduct = (state: WorldState, productId: string) =>
  required(state.products.find((p) => p.productId === productId))

const FakeCdr = Layer.effect(
  CdrClient,
  Effect.gen(function* () {
    const world = yield* World

    return CdrClient.of({
      brands: Effect.succeed([
        new DataHolderBrand({ brandName: "Example Bank", industries: ["banking"], publicBaseUri: BASE_URI })
      ]),
      listProducts: () =>
        Ref.get(world).pipe(
          Effect.map((state) =>
            state.products.map((p) => ({ productId: p.productId, name: p.name, productCategory: p.productCategory }))
          )
        ),
      getProduct: (_baseUri, productId) =>
        Ref.get(world).pipe(
          Effect.flatMap((state) =>
            state.failing.has(productId)
              ? Effect.fail(new CdrError({ url: `${BASE_URI}/${productId}`, message: "TimeoutError" }))
              : Effect.succeed({
                  version: 4,
                  raw: findProduct(state, productId),
                  detail: findProduct(state, productId)
                })
          )
        )
    })
  })
)

const TempDirs = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped()

    return Layer.merge(Store.layer(path.join(root, "data")), Snapshots.layer(path.join(root, "history")))
  })
)

const Env = Layer.mergeAll(TempDirs, FakeCdr).pipe(
  Layer.provideMerge(Layer.effect(World, Ref.make(seeded))),
  Layer.provideMerge(BunServices.layer)
)

const syncOn = Effect.fn("syncOn")(function* (day: number, state: WorldState = seeded) {
  yield* Ref.set(yield* World, state)
  yield* TestClock.setTime(Date.UTC(2026, 10, day, 21))

  return yield* syncCdr({ dryRun: false })
})

const storedCard = Effect.fn("storedCard")(function* (key: string) {
  const store = yield* Store

  return required((yield* store.load).cards.get(key))
})

describe("syncCdr", () => {
  layer(Env, { buildPerTest: true })((it) => {
    it.effect("adds new cards with the fields CDR publishes", () =>
      Effect.gen(function* () {
        const report = yield* syncOn(1)
        assert.strictEqual(report.added.length, 10)

        const card = yield* storedCard("example-bank/card-p1")
        assert.strictEqual(card.fees.annual, 99)
        assert.strictEqual(card.fees.late_payment, 15)
        assert.strictEqual(card.fees.foreign_txn_pct, 3)
        assert.strictEqual(card.first_seen, "2026-11-01")
      })
    )

    it.effect("never marks a listed card missing when only its detail request fails", () =>
      Effect.gen(function* () {
        yield* syncOn(1)
        const flaky = { ...seeded, failing: new Set(["p1"]) }

        for (const day of [2, 3]) {
          const report = yield* syncOn(day, flaky)
          assert.deepStrictEqual(report.missing, [])
          assert.deepStrictEqual(report.discontinued, [])
        }

        const card = yield* storedCard("example-bank/card-p1")
        assert.strictEqual(card.status, "active")
        assert.isUndefined(card.missing_since)
      })
    )

    it.effect("discontinues an unlisted card only after a later day still misses it", () =>
      Effect.gen(function* () {
        yield* syncOn(1)
        const gone = { ...seeded, products: seeded.products.filter((p) => p.productId !== "p1") }

        assert.deepStrictEqual((yield* syncOn(2, gone)).missing, ["example-bank/card-p1"])
        assert.deepStrictEqual((yield* syncOn(3, gone)).discontinued, ["example-bank/card-p1"])

        const card = yield* storedCard("example-bank/card-p1")
        assert.strictEqual(card.status, "discontinued")
        assert.strictEqual(card.discontinued, "2026-11-02")

        yield* syncOn(4)
        assert.strictEqual((yield* storedCard("example-bank/card-p1")).status, "active")
      })
    )

    it.effect("holds a large annual fee jump and leaves the stored fee alone", () =>
      Effect.gen(function* () {
        yield* syncOn(1)
        const jumped = { ...seeded, products: [product("p1", "450.00"), ...seeded.products.slice(1)] }
        const report = yield* syncOn(2, jumped)

        assert.deepStrictEqual(
          report.holds.map((hold) => [hold.card, hold.change]),
          [["example-bank/card-p1", "fees.annual"]]
        )
        assert.strictEqual((yield* storedCard("example-bank/card-p1")).fees.annual, 99)
      })
    )

    it.effect("aborts when far fewer cards come back than are active", () =>
      Effect.gen(function* () {
        yield* syncOn(1)
        const outage = { ...seeded, failing: new Set(seeded.products.slice(0, 3).map((p) => p.productId)) }
        const error = yield* syncOn(2, outage).pipe(Effect.flip)

        assert.strictEqual(error._tag, "SyncAborted")
      })
    )
  })
})
