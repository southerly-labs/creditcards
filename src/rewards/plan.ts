import { encodeJson } from "../util/json.ts"
import { Data } from "effect"
import type { Card, EarnRate } from "../model/schema.ts"
import { type LoyaltyFeature, loyaltyTextHash, ParseResult, parseEarn } from "./parse.ts"

// Decides what to do with a card's earn rates given its current CDR loyalty
// text. Manual earn rates are never replaced; a change in their source text
// only flags them for review.

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
      current?.earn_source === "parser" && current.earn_text_hash === hash && equal(current.earn, parsed.earn)
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
