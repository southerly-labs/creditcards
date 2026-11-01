import { encodeJson } from "../util/json.ts"
import { Data } from "effect"
import type { BonusTranche, Card, EarnRate } from "../model/schema.ts"
import type { SignupReview } from "../offers/schema.ts"
import { BonusResult, bonusTextHash, parseBonus } from "./bonus.ts"
import { type LoyaltyFeature, loyaltyTextHash, ParseResult, parseEarn } from "./parse.ts"

export type RewardsPlan =
  | { readonly _tag: "Unchanged" }
  | { readonly _tag: "Set"; readonly earn: ReadonlyArray<EarnRate>; readonly hash: string }
  | { readonly _tag: "Review"; readonly reason: string; readonly hash: string }

export const RewardsPlan = Data.taggedEnum<RewardsPlan>()

const equal = (a: unknown, b: unknown) =>
  a === undefined || b === undefined ? a === b : encodeJson(a) === encodeJson(b)

export const planRewards = (
  current: Card["rewards"] | undefined,
  features: ReadonlyArray<LoyaltyFeature>
): RewardsPlan => {
  const hash = loyaltyTextHash(features)

  if (current?.earn_source === "manual") {
    return current.earn_text_hash === hash
      ? RewardsPlan.Unchanged()
      : RewardsPlan.Review({ reason: "loyalty text changed since manual review", hash })
  }

  const parsed = parseEarn(features)

  if (ParseResult.$is("Parsed")(parsed)) {
    const same =
      current?.earn_source === "parser" &&
      current.earn_review?.state === "present" &&
      current.earn_text_hash === hash &&
      equal(current.earn, parsed.earn)

    return same ? RewardsPlan.Unchanged() : RewardsPlan.Set({ earn: parsed.earn, hash })
  }

  if (current?.earn_source === "parser") {
    return RewardsPlan.Review({
      reason: `loyalty text changed and the parser can no longer read it (${parsed.reason})`,
      hash
    })
  }

  return RewardsPlan.Review({ reason: parsed.reason, hash })
}

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

export const applyBonusPlan = (current: SignupState, plan: BonusPlan): SignupState =>
  BonusPlan.$match(plan, {
    Unchanged: () => current,
    Set: ({ bonus, hash }) => ({
      review: { state: "present" as const, source: "parser" as const, text_hash: hash },
      parsed: bonus
    }),
    Clear: () => cleared,
    Review: ({ clear }) => (clear ? cleared : current)
  })

export const planBonus = (current: SignupState, features: ReadonlyArray<LoyaltyFeature>): BonusPlan => {
  const hash = bonusTextHash(features)
  const review = current.review

  if (review?.source === "manual") {
    return review.text_hash === hash
      ? BonusPlan.Unchanged()
      : BonusPlan.Review({ reason: "bonus text changed since manual review", clear: false })
  }

  const parsed = parseBonus(features)
  const hasParsed = review?.source === "parser"

  if (BonusResult.$is("Review")(parsed)) return BonusPlan.Review({ reason: parsed.reason, clear: hasParsed })

  if (parsed.bonus.length === 0) return hasParsed ? BonusPlan.Clear() : BonusPlan.Unchanged()

  const same =
    hasParsed && review.state === "present" && review.text_hash === hash && equal(current.parsed, parsed.bonus)

  return same ? BonusPlan.Unchanged() : BonusPlan.Set({ bonus: parsed.bonus, hash })
}
