import { Effect } from "effect"
import { dual } from "effect/Function"
import { ReviewEvent, SourceReview, unread } from "../machine/review.ts"
import type { Card } from "../model/schema.ts"
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

const legacyEarnState = (rewards: NonNullable<Card["rewards"]>): SourceReview => {
  const hash = rewards.earn_text_hash ?? ""

  if (rewards.earn_source === "manual") {
    return SourceReview.cases.Reviewed.make({
      hash,
      outcome: rewards.earn?.length === 0 ? "none" : "present",
      ...(rewards.earn_review?.reviewed_at === undefined ? {} : { on: rewards.earn_review.reviewed_at })
    })
  }

  if (rewards.earn_source === "parser")
    return rewards.earn_review?.state === "unknown"
      ? SourceReview.cases.Unreadable.make({ hash })
      : SourceReview.cases.Parsed.make({ hash })

  return unread
}

export const earnStateOf = (card: Pick<Card, "rewards" | "earn_state"> | undefined): SourceReview =>
  card?.earn_state ?? (card?.rewards === undefined ? unread : legacyEarnState(card.rewards))

const legacySignupState = (review: NonNullable<Card["signup_review"]>): SourceReview => {
  const hash = review.text_hash ?? ""

  if (review.source === "manual") {
    return SourceReview.cases.Reviewed.make({
      hash,
      outcome: review.state === "none" ? "none" : "present",
      ...(review.reviewed_at === undefined ? {} : { on: review.reviewed_at })
    })
  }

  return review.source === "parser" && review.state === "present" ? SourceReview.cases.Parsed.make({ hash }) : unread
}

export const signupStateOf = (card: Pick<Card, "signup_review" | "signup_state"> | undefined): SourceReview =>
  card?.signup_state ?? (card?.signup_review === undefined ? unread : legacySignupState(card.signup_review))

export const withoutLegacyEarn = (rewards: NonNullable<Card["rewards"]>): NonNullable<Card["rewards"]> => {
  const { earn_source: _source, earn_review: _review, earn_text_hash: _hash, ...rest } = rewards

  return rest
}

function publicRewardsImpl(rewards: NonNullable<Card["rewards"]>, state: SourceReview): NonNullable<Card["rewards"]> {
  const { earn_source: _source, earn_review: _review, earn_text_hash: _hash, ...stored } = rewards
  const earned = publicEarnFields(state)

  return { ...stored, ...earned }
}

export const publicRewards = dual<
  (state: SourceReview) => (rewards: NonNullable<Card["rewards"]>) => NonNullable<Card["rewards"]>,
  (rewards: NonNullable<Card["rewards"]>, state: SourceReview) => NonNullable<Card["rewards"]>
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

export const publicSignupReview = (state: SourceReview): Card["signup_review"] =>
  SourceReview.match(state, {
    Unread: () => undefined,
    Parsed: ({ hash }) => ({ state: "present" as const, source: "parser" as const, text_hash: hash }),
    Unreadable: () => ({ state: "unknown" as const }),
    Reviewed: (review) => manualSignup(review),
    Stale: (review) => manualSignup(review)
  })
