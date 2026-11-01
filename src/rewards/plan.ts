import { encodeJson } from "../util/json.ts"
import { Data } from "effect"
import type { BonusTranche, Card, EarnRate } from "../model/schema.ts"
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

export type BonusPlan =
  | { readonly _tag: "Unchanged" }
  | { readonly _tag: "Set"; readonly bonus: ReadonlyArray<BonusTranche>; readonly hash: string }
  | { readonly _tag: "Clear" }
  | { readonly _tag: "Review"; readonly reason: string; readonly clear: boolean }

export const BonusPlan = Data.taggedEnum<BonusPlan>()

type Rewards = NonNullable<Card["rewards"]>

const withoutBonus = ({ bonus: _bonus, bonus_source: _source, bonus_text_hash: _hash, ...rest }: Rewards) => rest

export const applyBonusPlan = (rewards: Rewards, plan: BonusPlan): Rewards =>
  BonusPlan.$match(plan, {
    Unchanged: () => rewards,
    Set: ({ bonus, hash }) => ({ ...rewards, bonus, bonus_source: "parser" as const, bonus_text_hash: hash }),
    Clear: () => withoutBonus(rewards),
    Review: ({ clear }) => (clear ? withoutBonus(rewards) : rewards)
  })

export const planBonus = (current: Rewards | undefined, features: ReadonlyArray<LoyaltyFeature>): BonusPlan => {
  const hash = bonusTextHash(features)

  if (current?.bonus_source === "manual") {
    return current.bonus_text_hash === hash
      ? BonusPlan.Unchanged()
      : BonusPlan.Review({ reason: "bonus text changed since manual review", clear: false })
  }

  const parsed = parseBonus(features)
  const hasParsed = current?.bonus_source === "parser"

  if (BonusResult.$is("Review")(parsed)) return BonusPlan.Review({ reason: parsed.reason, clear: hasParsed })

  if (parsed.bonus.length === 0) return hasParsed ? BonusPlan.Clear() : BonusPlan.Unchanged()
  const same = hasParsed && current.bonus_text_hash === hash && equal(current.bonus, parsed.bonus)

  return same ? BonusPlan.Unchanged() : BonusPlan.Set({ bonus: parsed.bonus, hash })
}
