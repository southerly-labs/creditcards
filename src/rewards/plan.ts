import { jsonEqual } from "../util/json.ts"
import { Data, Effect } from "effect"
import type { BonusTranche, Card, EarnRate } from "../model/schema.ts"
import type { SignupReview } from "../offers/schema.ts"
import { BonusResult, parseBonus } from "./bonus.ts"
import { type LoyaltyFeature, ParseResult, parseEarn } from "./parse.ts"
import { SourceReview, stepReview } from "../machine/review.ts"
import { bonusRead, earnRead, earnStateOf, signupStateOf } from "./state.ts"
import { dual } from "effect/Function"

export type RewardsPlan =
  | { readonly _tag: "Unchanged" }
  | { readonly _tag: "Set"; readonly earn: ReadonlyArray<EarnRate>; readonly hash: string }
  | { readonly _tag: "Review"; readonly reason: string; readonly hash: string }

export const RewardsPlan = Data.taggedEnum<RewardsPlan>()

export const planRewards = Effect.fn("planRewards")(function* (
  current: Card["rewards"] | undefined,
  features: ReadonlyArray<LoyaltyFeature>,
  previous: SourceReview = earnStateOf(current === undefined ? {} : { rewards: current })
) {
  const read = yield* earnRead(features)
  const next = yield* stepReview(previous, read)
  const hash = read.hash
  const parsed = parseEarn(features)

  if (SourceReview.guards.Stale(next))
    return RewardsPlan.Review({ reason: "loyalty text changed since manual review", hash })

  if (SourceReview.guards.Unreadable(next) && ParseResult.$is("Review")(parsed)) {
    return RewardsPlan.Review({
      reason: SourceReview.guards.Parsed(previous)
        ? `loyalty text changed and the parser can no longer read it (${parsed.reason})`
        : parsed.reason,
      hash
    })
  }

  if (!SourceReview.guards.Parsed(next) || !ParseResult.$is("Parsed")(parsed)) return RewardsPlan.Unchanged()

  const same =
    SourceReview.guards.Parsed(previous) && previous.hash === hash && (yield* jsonEqual(current?.earn, parsed.earn))

  return same ? RewardsPlan.Unchanged() : RewardsPlan.Set({ earn: parsed.earn, hash })
})

export type BonusPlan =
  | { readonly _tag: "Unchanged" }
  | { readonly _tag: "Set"; readonly bonus: ReadonlyArray<BonusTranche>; readonly hash: string }
  | { readonly _tag: "Clear" }
  | { readonly _tag: "Review"; readonly reason: string; readonly clear: boolean }

export const BonusPlan = Data.taggedEnum<BonusPlan>()

export interface SignupState {
  readonly review: SignupReview | undefined
  readonly parsed: ReadonlyArray<BonusTranche> | undefined
}

const cleared: SignupState = { review: { state: "unknown" }, parsed: undefined }

export const applyBonusPlan = dual<
  (plan: BonusPlan) => (current: SignupState) => SignupState,
  (current: SignupState, plan: BonusPlan) => SignupState
>(2, (current: SignupState, plan: BonusPlan): SignupState =>
  BonusPlan.$match(plan, {
    Unchanged: () => current,
    Set: ({ bonus, hash }) => ({
      review: { state: "present" as const, source: "parser" as const, text_hash: hash },
      parsed: bonus
    }),
    Clear: () => cleared,
    Review: ({ clear }) => (clear ? cleared : current)
  })
)

const signupPrevious = (current: SignupState): SourceReview =>
  signupStateOf(current.review === undefined ? {} : { signup_review: current.review })

export const planBonus = Effect.fn("planBonus")(function* (
  current: SignupState,
  features: ReadonlyArray<LoyaltyFeature>,
  previous: SourceReview = signupPrevious(current)
) {
  const read = yield* bonusRead(features)
  const next = yield* stepReview(previous, read)
  const parsed = parseBonus(features)
  const wasParsed = SourceReview.guards.Parsed(previous)

  if (SourceReview.guards.Stale(next))
    return BonusPlan.Review({ reason: "bonus text changed since manual review", clear: false })

  if (BonusResult.$is("Review")(parsed))
    return SourceReview.guards.Unreadable(next)
      ? BonusPlan.Review({ reason: parsed.reason, clear: wasParsed })
      : BonusPlan.Unchanged()

  if (SourceReview.guards.Unread(next)) return wasParsed ? BonusPlan.Clear() : BonusPlan.Unchanged()

  if (!SourceReview.guards.Parsed(next)) return BonusPlan.Unchanged()

  const same = wasParsed && previous.hash === read.hash && (yield* jsonEqual(current.parsed, parsed.bonus))

  return same ? BonusPlan.Unchanged() : BonusPlan.Set({ bonus: parsed.bonus, hash: read.hash })
})
