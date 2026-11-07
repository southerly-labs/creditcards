import { Effect } from "effect"
import { dual } from "effect/Function"
import { ReviewEvent, SourceReview, unread } from "../machine/review.ts"
import type { Card } from "../model/schema.ts"
import type { PublicRewards } from "../api/contract.ts"
import type { SignupReview } from "../offers/schema.ts"
import { BonusResult, bonusTextHash, parseBonus } from "./bonus.ts"
import { type LoyaltyFeature, loyaltyTextHash, ParseResult, parseEarn } from "./parse.ts"

export const earnRead = Effect.fn("earnRead")(function* (features: ReadonlyArray<LoyaltyFeature>) {
  return ReviewEvent.cases.Read.make({
    hash: yield* loyaltyTextHash(features),
    outcome: ParseResult.$is("Parsed")(parseEarn(features)) ? "parsed" : "unreadable"
  })
})

export const bonusRead = Effect.fn("bonusRead")(function* (features: ReadonlyArray<LoyaltyFeature>) {
  const parsed = parseBonus(features)

  return ReviewEvent.cases.Read.make({
    hash: yield* bonusTextHash(features),
    outcome: BonusResult.$is("Review")(parsed) ? "unreadable" : parsed.bonus.length === 0 ? "nothing" : "parsed"
  })
})

export const earnStateOf = (card: Pick<Card, "earn_state"> | undefined): SourceReview => card?.earn_state ?? unread

export const signupStateOf = (card: Pick<Card, "signup_state"> | undefined): SourceReview =>
  card?.signup_state ?? unread

function publicRewardsImpl(rewards: NonNullable<Card["rewards"]>, state: SourceReview): PublicRewards {
  const earned = publicEarnFields(state)

  return { ...rewards, ...earned }
}

export const publicRewards = dual<
  (state: SourceReview) => (rewards: NonNullable<Card["rewards"]>) => PublicRewards,
  (rewards: NonNullable<Card["rewards"]>, state: SourceReview) => PublicRewards
>(2, publicRewardsImpl)

const publicEarnFields = (state: SourceReview) =>
  SourceReview.match(state, {
    Unread: () => ({}),
    Parsed: ({ hash }) => ({
      earn_source: "parser" as const,
      earn_text_hash: hash,
      earn_review: { state: "present" as const }
    }),
    Unreadable: ({ hash }) => ({
      earn_source: "parser" as const,
      earn_text_hash: hash,
      earn_review: { state: "unknown" as const }
    }),
    Reviewed: (review) => manualEarn(review),
    Stale: (review) => manualEarn(review)
  })

const manualEarn = (review: { readonly hash: string; readonly outcome: "present" | "none"; readonly on?: string }) => ({
  earn_source: "manual" as const,
  earn_text_hash: review.hash,
  earn_review: { state: review.outcome, ...(review.on === undefined ? {} : { reviewed_at: review.on }) }
})

const manualSignup = (review: {
  readonly hash: string
  readonly outcome: "present" | "none"
  readonly on?: string
}) => ({
  state: review.outcome,
  source: "manual" as const,
  text_hash: review.hash,
  ...(review.on === undefined ? {} : { reviewed_at: review.on })
})

export const publicSignupReview = (state: SourceReview): SignupReview | undefined =>
  SourceReview.match(state, {
    Unread: () => undefined,
    Parsed: ({ hash }) => ({ state: "present" as const, source: "parser" as const, text_hash: hash }),
    Unreadable: () => ({ state: "unknown" as const }),
    Reviewed: (review) => manualSignup(review),
    Stale: (review) => manualSignup(review)
  })
