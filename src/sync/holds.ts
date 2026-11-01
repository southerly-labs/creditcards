import { Schema } from "effect"
import { Card } from "../model/schema.ts"
import { diffCard, getPath, heldFields, setPath } from "./merge.ts"

export type HoldKind = "approve" | "confirm"

export interface HoldCandidate {
  readonly change: string
  readonly reason: string
  readonly kind: HoldKind
  readonly current: unknown
  readonly proposed: unknown
}

const REVERTED_WITH: Readonly<Record<string, ReadonlyArray<string>>> = {
  "rewards.earn": ["rewards.earn", "rewards.earn_source", "rewards.earn_text_hash", "rewards.earn_review"]
}

const OFFER_PREFIX = "offers."

export const holdCandidates = (existing: Card, proposed: Card): ReadonlyArray<HoldCandidate> =>
  heldFields(diffCard(existing, proposed)).map(({ path, reason }) => ({
    change: path,
    reason,
    kind: "approve",
    current: getPath(existing, path),
    proposed: getPath(proposed, path)
  }))

const revertOffer = (card: Card, existing: Card, id: string): Card => {
  const before = existing.offers?.find((offer) => offer.id === id)
  const after = card.offers ?? []
  const kept = after.flatMap((offer) => (offer.id !== id ? [offer] : before === undefined ? [] : [before]))
  const offers = before !== undefined && !after.some((offer) => offer.id === id) ? [...kept, before] : kept
  const { offers: _offers, signup_review: _review, ...rest } = card
  const review = id === "signup" ? existing.signup_review : card.signup_review

  return {
    ...rest,
    ...(offers.length === 0 ? {} : { offers }),
    ...(review === undefined ? {} : { signup_review: review })
  }
}

const isCard = Schema.is(Card)

export const revertChange = (card: Card, existing: Card, change: string): Card | undefined => {
  if (change.startsWith(OFFER_PREFIX)) return revertOffer(card, existing, change.slice(OFFER_PREFIX.length))
  const reverted: Record<string, unknown> = structuredClone(card)

  for (const path of REVERTED_WITH[change] ?? [change])
    setPath(reverted, path, structuredClone(getPath(existing, path)))

  return isCard(reverted) ? reverted : undefined
}
