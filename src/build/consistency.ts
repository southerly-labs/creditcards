import { Array as EffectArray, Option } from "effect"
import { SourceReview } from "../machine/review.ts"
import type { Card } from "../model/schema.ts"
import { getPath } from "../sync/merge.ts"

const reviewedOutcome = (state: SourceReview | undefined) =>
  state !== undefined && (SourceReview.guards.Reviewed(state) || SourceReview.guards.Stale(state))
    ? state.outcome
    : undefined

const earnProblems = (card: Card): ReadonlyArray<string> => {
  const earn = card.rewards?.earn ?? []
  const state = card.earn_state

  if (state !== undefined && SourceReview.guards.Parsed(state) && earn.length === 0)
    return ["earn_state is Parsed but rewards.earn is empty"]

  const outcome = reviewedOutcome(state)

  if (outcome === "present" && earn.length === 0)
    return ["earn_state records a reviewed earn rate but rewards.earn is empty"]

  if (outcome === "none" && earn.length > 0) return ["earn_state records no fixed earn rate but rewards.earn has rates"]

  return []
}

const signupProblems = (card: Card): ReadonlyArray<string> => {
  const outcome = reviewedOutcome(card.signup_state)
  const signup = Option.getOrUndefined(EffectArray.findFirst(card.offers ?? [], (offer) => offer.id === "signup"))

  if (outcome === "present" && signup?.source !== "manual")
    return ["signup_state records a reviewed signup offer but there is no manual signup offer"]

  if (outcome === "none" && signup !== undefined) return ["signup_state records no signup offer but the card has one"]

  return []
}

const GENERATED_IDS: Readonly<Record<"cdr" | "parser", RegExp>> = {
  cdr: /^(?:intro-(?:purchase|balance-transfer|both)(?:-\d+)?|first-year-fee|signup)$/u,
  parser: /^signup$/u
}

const offerProblems = (card: Card): ReadonlyArray<string> =>
  EffectArray.flatMap(card.offers ?? [], (offer) =>
    offer.source === "manual" || GENERATED_IDS[offer.source].test(offer.id)
      ? []
      : [`offer ${offer.id} has source ${offer.source}, which the sync never generates under that id`]
  )

const gapProblems = (card: Card): ReadonlyArray<string> =>
  EffectArray.flatMap(card.gaps ?? [], (gap) =>
    getPath(card, gap.field) === undefined ? [] : [`gap for ${gap.field} is stale: the field has a value`]
  )

export const cardProblems = (card: Card): ReadonlyArray<string> => [
  ...earnProblems(card),
  ...signupProblems(card),
  ...offerProblems(card),
  ...gapProblems(card)
]
