import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, Exit, Array as EffectArray, FileSystem, Layer, Path } from "effect"
import { Digest } from "effect/crypto"
import { CdrClient, CdrError } from "../../src/cdr/CdrClient.ts"
import { DataHolderBrand } from "../../src/cdr/schema.ts"
import { initialLifecycle } from "../../src/machine/cardLifecycle.ts"
import { loyaltyTextHash } from "../../src/rewards/parse.ts"
import { applyComment } from "../../src/review/apply.ts"
import { Store } from "../../src/store/Store.ts"
import { type SyncReport, summariseRewardsReview } from "../../src/sync/Sync.ts"
import {
  needsReview,
  type ReadOutcome,
  ReviewEvent,
  type ReviewOutcome,
  SourceReview,
  stepReview
} from "../../src/machine/review.ts"
import { ParsedComment, parseComment } from "../../src/review/commands.ts"
import { tlaConstant, tlaModule, tlaRows } from "./tla.ts"

const OLD = "1111111111111111"
const NEW = "2222222222222222"
const TODAY = "2026-11-02"

const STATES = [
  ["Unread", "-"],
  ["Parsed", "-"],
  ["Unreadable", "-"],
  ["Reviewed", "none"],
  ["Reviewed", "present"],
  ["Stale", "none"],
  ["Stale", "present"]
] as const

type StateInput = (typeof STATES)[number]

const stateOf = ([tag, outcome]: StateInput): SourceReview => {
  if (tag === "Unread") return SourceReview.cases.Unread.make({})

  if (tag === "Parsed") return SourceReview.cases.Parsed.make({ hash: OLD })

  if (tag === "Unreadable") return SourceReview.cases.Unreadable.make({ hash: OLD })

  const review = { hash: OLD, outcome: outcome === "none" ? "none" : "present", on: TODAY } as const

  return tag === "Reviewed" ? SourceReview.cases.Reviewed.make(review) : SourceReview.cases.Stale.make(review)
}

const hashOf = (state: SourceReview): string => {
  if (SourceReview.guards.Unread(state)) return "none"

  return state.hash === OLD ? "old" : "event"
}

const outcomeOf = (state: SourceReview): string =>
  SourceReview.guards.Reviewed(state) || SourceReview.guards.Stale(state) ? state.outcome : "-"

type EventInput =
  | { readonly kind: "Read"; readonly same: boolean; readonly outcome: ReadOutcome }
  | { readonly kind: "Stamp"; readonly same: boolean; readonly outcome: ReviewOutcome }

const EVENTS: ReadonlyArray<EventInput> = [
  ...EffectArray.flatMap([true, false], (same) =>
    EffectArray.map(["parsed", "nothing", "unreadable"] as const, (outcome): EventInput => ({
      kind: "Read",
      same,
      outcome
    }))
  ),
  ...EffectArray.flatMap([true, false], (same) =>
    EffectArray.map(["none", "present"] as const, (outcome): EventInput => ({ kind: "Stamp", same, outcome }))
  )
]

const eventOf = (input: EventInput): ReviewEvent => {
  const hash = input.same ? OLD : NEW

  return input.kind === "Read"
    ? ReviewEvent.cases.Read.make({ hash, outcome: input.outcome })
    : ReviewEvent.cases.Stamp.make({ hash, outcome: input.outcome, on: TODAY })
}

const reviewRow = Effect.fn("reviewRow")(function* (state: StateInput, input: EventInput) {
  const next = yield* stepReview(stateOf(state), eventOf(input))

  return [state[0], state[1], input.kind, input.same, input.outcome, next._tag, hashOf(next), outcomeOf(next)]
})

const accepted = (body: string) => ParsedComment.$is("Commands")(parseComment(body))

const BASE_URI = "https://cdr.bank.example"

const feature = (info: string) => [{ featureType: "LOYALTY_PROGRAM", additionalValue: "Points", additionalInfo: info }]

const LISTED_TEXT = feature("See the website for earn rates")

const EDITED_TEXT = feature("Earn 2 points per $1 on travel")

const issuer = { features: LISTED_TEXT }

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

const emptyReport = (hash: string): SyncReport => ({
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
  rewards: { set: [], review: [{ card: "bank/card", reason: "unreadable", hash }] },
  bonus: { set: [], review: [], undetailed: [] }
})

const seedCard = Effect.gen(function* () {
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

const TempStore = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    return Store.layer(path.join(yield* fs.makeTempDirectoryScoped(), "data"))
  })
)

const replyLands = Effect.fn("replyLands")(function* (pinned: boolean, textChanged: boolean) {
  const listedHash = yield* loyaltyTextHash(LISTED_TEXT)
  const issue = summariseRewardsReview(emptyReport(listedHash))
  const body = pinned ? `/earn-none bank/card@${listedHash}` : "/earn-none bank/card"

  issuer.features = LISTED_TEXT
  yield* seedCard
  issuer.features = textChanged ? EDITED_TEXT : LISTED_TEXT

  return yield* applyComment(body, { by: "verify", url: "https://verify.example", issue })
})

const stampLands = (pinned: boolean, textChanged: boolean) =>
  replyLands(pinned, textChanged).pipe(
    Effect.exit,
    Effect.map((exit) => [pinned, textChanged, Exit.isSuccess(exit)])
  )

const program = Effect.gen(function* () {
  const rows = yield* Effect.forEach(
    EffectArray.flatMap(STATES, (state) => EffectArray.map(EVENTS, (input) => [state, input] as const)),
    ([state, input]) => reviewRow(state, input)
  )

  const needs = EffectArray.map(STATES, (state) => [state[0], state[1], needsReview(stateOf(state))])

  const stamps = yield* Effect.forEach(
    EffectArray.flatMap([true, false], (pinned) =>
      EffectArray.map([true, false], (changed) => [pinned, changed] as const)
    ),
    ([pinned, changed]) => stampLands(pinned, changed)
  )

  yield* Console.log(
    tlaModule(
      "RewardsReviewCode",
      ["src/machine/review.ts", "src/review/commands.ts (parseComment)", "src/review/apply.ts (applyComment)"],
      [
        tlaRows("ReviewRows", rows),
        tlaRows("NeedsReviewRows", needs),
        tlaConstant("BareStampAccepted", accepted("/earn-none example/card")),
        tlaConstant("PinnedStampAccepted", accepted(`/earn-none example/card@${NEW}`)),
        tlaRows("StampLandsRows", stamps)
      ]
    )
  )
})

const Env = Layer.mergeAll(TempStore, FakeCdr, Digest.layerWebCrypto).pipe(Layer.provideMerge(BunServices.layer))

BunRuntime.runMain(program.pipe(Effect.provide(Env)))
