import { BunServices } from "@effect/platform-bun"
import { assert, describe, layer } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer, Path, Ref, Array as EffectArray, Option } from "effect"
import { TestClock } from "effect/testing"
import { CdrClient, CdrError } from "../src/cdr/CdrClient.ts"
import { DataHolderBrand, type ProductDetail } from "../src/cdr/schema.ts"
import { Snapshots } from "../src/history/Snapshots.ts"
import { splitCardKey, Store } from "../src/store/Store.ts"
import { checkReferences } from "../src/build/build.ts"
import { holdIdProblems } from "../src/build/holdChecks.ts"
import { LISTING_CHANGE, syncCdr } from "../src/sync/Sync.ts"
import { decideHold } from "../src/sync/heldCommand.ts"
import { required } from "../src/util/required.ts"
import { Digest } from "effect/crypto"
import { statusOf } from "../src/model/lifecycle.ts"

const BASE_URI = "https://cdr.bank.example"
const CARDLESS_URI = "https://cdr.cardless.example"
const SMALL_URI = "https://cdr.small.example"

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
  readonly renamed?: Readonly<Record<string, string>>
  readonly brandName?: string
  readonly listFailures?: number
  readonly cardlessDown?: boolean
  readonly small?: ReadonlyArray<ProductDetail>
}

const seeded: WorldState = {
  products: EffectArray.map(["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10"], (id) =>
    product(id, "99.00")
  ),
  failing: new Set()
}

class World extends Context.Service<World, Ref.Ref<WorldState>>()("creditcards/test/sync.test/World") {}

const findProduct = (state: WorldState, productId: string) =>
  required(
    Option.getOrUndefined(
      EffectArray.findFirst([...state.products, ...(state.small ?? [])], (p) => p.productId === productId)
    )
  )

const listed = (products: ReadonlyArray<ProductDetail>) =>
  EffectArray.map(products, (p) => ({ productId: p.productId, name: p.name, productCategory: p.productCategory }))

const detailFor = (state: WorldState, productId: string): ProductDetail => {
  const detail = findProduct(state, productId)

  return { ...detail, productId: state.renamed?.[productId] ?? productId }
}

const FakeCdr = Layer.effect(
  CdrClient,
  Effect.gen(function* () {
    const world = yield* World

    return CdrClient.of({
      brands: Ref.get(world).pipe(
        Effect.map((state) => [
          DataHolderBrand.make({
            brandName: state.brandName ?? "Example Bank",
            dataHolderBrandId: "example-bank-id",
            industries: ["banking"],
            publicBaseUri: BASE_URI
          }),
          DataHolderBrand.make({ brandName: "Cardless Bank", industries: ["banking"], publicBaseUri: CARDLESS_URI }),
          DataHolderBrand.make({
            brandName: "Small Bank",
            dataHolderBrandId: "small-bank-id",
            industries: ["banking"],
            publicBaseUri: SMALL_URI
          })
        ])
      ),
      listProducts: (baseUri) =>
        Ref.getAndUpdate(world, (state) =>
          baseUri === BASE_URI ? { ...state, listFailures: Math.max((state.listFailures ?? 0) - 1, 0) } : state
        ).pipe(
          Effect.flatMap((state) =>
            (baseUri === CARDLESS_URI ? state.cardlessDown === true : (state.listFailures ?? 0) > 0)
              ? Effect.fail(CdrError.make({ url: baseUri, message: "TimeoutError" }))
              : Effect.succeed(
                  baseUri === CARDLESS_URI
                    ? []
                    : baseUri === SMALL_URI
                      ? listed(state.small ?? [])
                      : listed(state.products)
                )
          )
        ),
      getProduct: (_baseUri, productId) =>
        Ref.get(world).pipe(
          Effect.flatMap((state) =>
            state.failing.has(productId)
              ? Effect.fail(CdrError.make({ url: `${BASE_URI}/${productId}`, message: "TimeoutError" }))
              : Effect.succeed({
                  version: 4,
                  raw: findProduct(state, productId),
                  detail: detailFor(state, productId)
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

const Env = Layer.mergeAll(TempDirs, FakeCdr, Digest.layerWebCrypto).pipe(
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
        assert.deepStrictEqual(card.cdr, { brand: "Example Bank", brand_id: "example-bank-id", product_id: "p1" })
      })
    )

    it.effect("retries a brand whose product list fails once", () =>
      Effect.gen(function* () {
        yield* syncOn(1)
        const report = yield* syncOn(2, { ...seeded, listFailures: 1 })

        assert.strictEqual(report.cardsSeen, 10)
        assert.deepStrictEqual(report.brandErrors, [])
      })
    )

    it.effect("retries a failing brand only once", () =>
      Effect.gen(function* () {
        yield* syncOn(1)
        const error = yield* Effect.flip(syncOn(2, { ...seeded, listFailures: 2 }))

        assert.strictEqual(error._tag, "SyncAborted")
      })
    )

    it.effect("only counts unreachable brands that have no cards", () =>
      Effect.gen(function* () {
        const report = yield* syncOn(1, { ...seeded, cardlessDown: true })

        assert.deepStrictEqual(report.brandErrors, [])
        assert.strictEqual(report.cardlessBrandErrors, 1)
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

        const card = statusOf(yield* storedCard("example-bank/card-p1"))
        assert.strictEqual(card.status, "active")
        assert.isUndefined(card.missing_since)
      })
    )

    it.effect("treats a detail response for a different product id as a failed request", () =>
      Effect.gen(function* () {
        yield* syncOn(1)
        const renamed = { ...seeded, renamed: { p1: "P1" } }

        for (const day of [2, 3]) {
          const report = yield* syncOn(day, renamed)
          assert.deepStrictEqual(report.added, [])
          assert.deepStrictEqual(report.missing, [])
        }

        assert.strictEqual(statusOf(yield* storedCard("example-bank/card-p1")).status, "active")
      })
    )

    it.effect("follows a renamed brand by its Register id instead of seeing new cards", () =>
      Effect.gen(function* () {
        yield* syncOn(1)
        const report = yield* syncOn(2, { ...seeded, brandName: "Example Bank Australia" })

        assert.deepStrictEqual(report.added, [])
        assert.deepStrictEqual(report.missing, [])
        assert.strictEqual((yield* storedCard("example-bank/card-p1")).cdr?.brand, "Example Bank Australia")

        const dataset = yield* (yield* Store).load
        assert.deepStrictEqual(dataset.issuers.get("example-bank")?.cdr_brands, [
          "Example Bank",
          "Example Bank Australia"
        ])
        assert.deepStrictEqual(checkReferences(dataset), [])
      })
    )

    it.effect("still matches cards stored before they recorded a brand id", () =>
      Effect.gen(function* () {
        yield* syncOn(1)
        const store = yield* Store

        for (const [key, card] of (yield* store.load).cards) {
          const { brand_id: _id, ...cdr } = required(card.cdr)
          const { issuer, card: slug } = splitCardKey(key)
          yield* store.writeCard(issuer, slug, { ...card, cdr })
        }

        const report = yield* syncOn(2)
        assert.deepStrictEqual(report.added, [])
        assert.deepStrictEqual(report.missing, [])
        assert.strictEqual((yield* storedCard("example-bank/card-p1")).cdr?.brand_id, "example-bank-id")
      })
    )

    it.effect("discontinues an unlisted card only after a later day still misses it", () =>
      Effect.gen(function* () {
        yield* syncOn(1)
        const gone = { ...seeded, products: EffectArray.filter(seeded.products, (p) => p.productId !== "p1") }

        assert.deepStrictEqual((yield* syncOn(2, gone)).missing, ["example-bank/card-p1"])
        assert.deepStrictEqual((yield* syncOn(3, gone)).discontinued, ["example-bank/card-p1"])

        const card = statusOf(yield* storedCard("example-bank/card-p1"))
        assert.strictEqual(card.status, "discontinued")
        assert.strictEqual(card.discontinued, "2026-11-02")

        yield* syncOn(4)
        assert.strictEqual(statusOf(yield* storedCard("example-bank/card-p1")).status, "active")
      })
    )

    it.effect("holds cards that vanish together for approval instead of marking them missing", () =>
      Effect.gen(function* () {
        const withSmall = { ...seeded, small: [product("s1", "99.00"), product("s2", "99.00")] }
        yield* syncOn(1, withSmall)

        const report = yield* syncOn(2)
        const vanished = EffectArray.filter(report.holds, (hold) => hold.change === LISTING_CHANGE)

        assert.deepStrictEqual(report.missing, [])
        assert.deepStrictEqual(report.held, [])
        assert.deepStrictEqual(
          EffectArray.map(vanished, (hold) => [hold.state._tag, hold.reason, hold.proposed]),
          EffectArray.replicate(["AwaitingApproval", "2/2 Small Bank cards vanished at once", '{"_tag":"Missing"}'], 2)
        )

        const stored = yield* (yield* Store).load
        assert.deepStrictEqual(checkReferences(stored), [])
        assert.deepStrictEqual(yield* holdIdProblems(stored.holds ?? []), [])

        const [first, second] = [required(vanished[0]), required(vanished[1])]
        assert.isUndefined(statusOf(yield* storedCard(first.card)).missing_since)
        assert.deepStrictEqual(
          EffectArray.map((yield* syncOn(3)).holds, (hold) => hold.id),
          [first.id, second.id]
        )

        yield* decideHold(first.id, "approve", "the issuer closed this range")
        const approved = yield* syncOn(4)

        assert.deepStrictEqual(approved.missing, [first.card])
        assert.deepStrictEqual(
          EffectArray.map(approved.released, (hold) => hold.id),
          [first.id]
        )
        assert.deepStrictEqual(
          EffectArray.map(approved.holds, (hold) => hold.id),
          [second.id]
        )
        assert.strictEqual(statusOf(yield* storedCard(first.card)).missing_since, "2026-11-04")

        const back = yield* syncOn(5, withSmall)
        assert.deepStrictEqual(back.holds, [])
        assert.strictEqual(statusOf(yield* storedCard(first.card)).status, "active")
      })
    )

    it.effect("holds a large annual fee jump and leaves the stored fee alone", () =>
      Effect.gen(function* () {
        yield* syncOn(1)
        const jumped = { ...seeded, products: [product("p1", "450.00"), ...seeded.products.slice(1)] }
        const report = yield* syncOn(2, jumped)

        assert.deepStrictEqual(
          EffectArray.map(report.holds, (hold) => [hold.card, hold.change]),
          [["example-bank/card-p1", "fees.annual"]]
        )
        assert.strictEqual((yield* storedCard("example-bank/card-p1")).fees.annual, 99)
      })
    )

    it.effect("applies a large fee change the issuer's CDR data shows once a later day still shows it", () =>
      Effect.gen(function* () {
        yield* syncOn(1)
        const jumped = { ...seeded, products: [product("p1", "450.00"), ...seeded.products.slice(1)] }
        const held = required((yield* syncOn(2, jumped)).holds[0])

        assert.strictEqual(held.state._tag, "AwaitingConfirmation")
        assert.strictEqual(held.cdr_evidence, "CDR snapshot 2026-11-01 gives 99; today's gives 450")
        assert.strictEqual((yield* storedCard("example-bank/card-p1")).fees.annual, 99)

        const report = yield* syncOn(3, jumped)
        assert.deepStrictEqual(
          EffectArray.map(report.released, (hold) => hold.change),
          ["fees.annual"]
        )
        assert.strictEqual((yield* storedCard("example-bank/card-p1")).fees.annual, 450)
      })
    )

    it.effect("leaves an implausible fee for a reviewer even when CDR shows it", () =>
      Effect.gen(function* () {
        yield* syncOn(1)
        const typo = { ...seeded, products: [product("p1", "3000.00"), ...seeded.products.slice(1)] }
        const held = required((yield* syncOn(2, typo)).holds[0])

        assert.strictEqual(held.state._tag, "AwaitingApproval")
        assert.isUndefined(held.cdr_evidence)
      })
    )

    it.effect("leaves a change for a reviewer when the CDR response did not change", () =>
      Effect.gen(function* () {
        yield* syncOn(1)
        const card = yield* storedCard("example-bank/card-p1")
        yield* (yield* Store).writeCard("example-bank", "card-p1", { ...card, fees: { ...card.fees, annual: 450 } })
        const held = required((yield* syncOn(2)).holds[0])

        assert.strictEqual(held.state._tag, "AwaitingApproval")
        assert.isUndefined(held.cdr_evidence)
      })
    )

    it.effect("holds a card whose generated offer is invalid and still syncs the rest", () =>
      Effect.gen(function* () {
        yield* syncOn(1)
        const p1 = required(seeded.products[0])

        const badIntro = {
          ...p1,
          lendingRates: [
            ...(p1.lendingRates ?? []),
            { lendingRateType: "INTRODUCTORY", rate: "0.99", additionalValue: "P6M" }
          ]
        }

        const raised = EffectArray.map(seeded.products.slice(1), (p) => product(p.productId, "120.00"))
        const report = yield* syncOn(2, { ...seeded, products: [badIntro, ...raised] })

        assert.deepStrictEqual(
          EffectArray.map(report.held, (h) => h.card),
          ["example-bank/card-p1"]
        )
        assert.strictEqual((yield* storedCard("example-bank/card-p2")).fees.annual, 120)
        assert.isUndefined((yield* storedCard("example-bank/card-p1")).offers)
      })
    )

    it.effect("aborts when far fewer cards come back than are active", () =>
      Effect.gen(function* () {
        yield* syncOn(1)
        const outage = { ...seeded, failing: new Set(EffectArray.map(seeded.products.slice(0, 3), (p) => p.productId)) }
        const error = yield* syncOn(2, outage).pipe(Effect.flip)

        assert.strictEqual(error._tag, "SyncAborted")
      })
    )
  })
})
