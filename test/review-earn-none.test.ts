import { BunServices } from "@effect/platform-bun"
import { assert, describe, layer } from "@effect/vitest"
import { Effect, Array as EffectArray, FileSystem, Layer, Path } from "effect"
import { Digest } from "effect/crypto"
import { CdrClient, CdrError } from "../src/cdr/CdrClient.ts"
import { DataHolderBrand } from "../src/cdr/schema.ts"
import { initialLifecycle } from "../src/machine/cardLifecycle.ts"
import { bonusTextHash } from "../src/rewards/bonus.ts"
import { loyaltyTextHash } from "../src/rewards/parse.ts"
import { applyComment } from "../src/review/apply.ts"
import { Store } from "../src/store/Store.ts"
import { type SyncReport, summariseRewardsReview } from "../src/sync/Sync.ts"
import { required } from "../src/util/required.ts"

const BASE_URI = "https://cdr.bank.example"

interface Feature {
  readonly featureType: string
  readonly additionalValue: string
  readonly additionalInfo: string
}

const listedText: ReadonlyArray<Feature> = [
  { featureType: "LOYALTY_PROGRAM", additionalValue: "Points", additionalInfo: "See the website for earn rates" },
  { featureType: "BONUS_REWARDS", additionalValue: "Bonus", additionalInfo: "Bonus points, terms apply" }
]

const editedText: ReadonlyArray<Feature> = [
  { featureType: "LOYALTY_PROGRAM", additionalValue: "Points", additionalInfo: "Earn 2 points per $1 on travel" },
  { featureType: "BONUS_REWARDS", additionalValue: "Bonus", additionalInfo: "100,000 bonus points in year one" }
]

const issuer = { features: listedText }

const ofType = (type: string) => EffectArray.filter(listedText, (feature) => feature.featureType === type)

const listedEarnHash = loyaltyTextHash(ofType("LOYALTY_PROGRAM"))

const listedBonusHash = bonusTextHash(ofType("BONUS_REWARDS"))

const FakeCdr = Layer.succeed(
  CdrClient,
  CdrClient.of({
    brands: Effect.succeed([
      DataHolderBrand.make({ brandName: "Bank", industries: ["banking"], publicBaseUri: BASE_URI })
    ]),
    listProducts: () => Effect.fail(CdrError.make({ url: BASE_URI, message: "unused" })),
    getProduct: (_baseUri, productId) => {
      const detail = { productId, name: "Card", productCategory: "CRED_AND_CHRG_CARDS", features: issuer.features }

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
  issuer.features = listedText
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

const reviewIssue = Effect.gen(function* () {
  const earnHash = yield* listedEarnHash
  const bonusHash = yield* listedBonusHash

  const report: SyncReport = {
    date: "2026-11-09",
    cardsSeen: 1,
    added: [],
    updated: [],
    discontinued: [],
    missing: [],
    held: [],
    holds: [],
    released: [],
    newIssuers: [],
    newPrograms: [],
    brandErrors: [],
    cardlessBrandErrors: 0,
    snapshotsSaved: 0,
    rewards: { set: [], review: [{ card: "bank/card", reason: "unreadable", hash: earnHash }] },
    bonus: { set: [], review: [{ card: "bank/card", reason: "unreadable", hash: bonusHash }], undetailed: [] }
  }

  return summariseRewardsReview(report)
})

const reply = (body: string, issue: string) =>
  applyComment(body, { by: "maintainer", url: "https://github.example/comment", issue })

const storedCard = Effect.gen(function* () {
  return required((yield* (yield* Store).load).cards.get("bank/card"))
})

describe("a bare /earn-none or /bonus-none reply", () => {
  layer(Env, { buildPerTest: true })((it) => {
    it.effect("is refused when the issuer changed the earn text after the issue listed it", () =>
      Effect.gen(function* () {
        yield* seed
        const issue = yield* reviewIssue
        issuer.features = editedText
        const error = yield* Effect.flip(reply("/earn-none bank/card", issue))

        assert.include(error.message, "the CDR text changed since it was listed")
        assert.isUndefined((yield* storedCard).earn_state)
      })
    )

    it.effect("is refused when the issuer changed the bonus text after the issue listed it", () =>
      Effect.gen(function* () {
        yield* seed
        const issue = yield* reviewIssue
        issuer.features = editedText
        const error = yield* Effect.flip(reply("/bonus-none bank/card", issue))

        assert.include(error.message, "the CDR text changed since it was listed")
        assert.isUndefined((yield* storedCard).signup_state)
      })
    )

    it.effect("still stamps the earn and bonus text the issue listed when it is unchanged", () =>
      Effect.gen(function* () {
        yield* seed
        const issue = yield* reviewIssue
        yield* reply("/earn-none bank/card\n/bonus-none bank/card", issue)
        const card = yield* storedCard

        assert.deepStrictEqual(
          [card.earn_state?._tag, card.earn_state?._tag === "Reviewed" ? card.earn_state.hash : undefined],
          ["Reviewed", yield* listedEarnHash]
        )
        assert.deepStrictEqual(
          [card.signup_state?._tag, card.signup_state?._tag === "Reviewed" ? card.signup_state.hash : undefined],
          ["Reviewed", yield* listedBonusHash]
        )
      })
    )
  })
})
