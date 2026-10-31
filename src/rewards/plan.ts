import type { Card, EarnRate } from "../model/schema.ts"
import { type LoyaltyFeature, loyaltyTextHash, parseEarn } from "./parse.ts"

// Decides what to do with a card's earn rates given its current CDR loyalty
// text. Manual earn rates are never replaced; a change in their source text
// only flags them for review.

export type RewardsPlan =
  | { readonly _tag: "Unchanged" }
  | { readonly _tag: "Set"; readonly earn: ReadonlyArray<EarnRate>; readonly hash: string }
  | { readonly _tag: "Review"; readonly reason: string; readonly hash: string }

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export const planRewards = (
  current: Card["rewards"] | undefined,
  features: ReadonlyArray<LoyaltyFeature>
): RewardsPlan => {
  const hash = loyaltyTextHash(features)
  if (current?.earn_source === "manual") {
    return current.earn_text_hash === hash
      ? { _tag: "Unchanged" }
      : { _tag: "Review", reason: "loyalty text changed since manual review", hash }
  }
  const parsed = parseEarn(features)
  if (parsed._tag === "Parsed") {
    const same = current?.earn_source === "parser" && current.earn_text_hash === hash && equal(current.earn, parsed.earn)
    return same ? { _tag: "Unchanged" } : { _tag: "Set", earn: parsed.earn, hash }
  }
  if (current?.earn_source === "parser") {
    return { _tag: "Review", reason: `loyalty text changed and the parser can no longer read it (${parsed.reason})`, hash }
  }
  return { _tag: "Review", reason: parsed.reason, hash }
}
