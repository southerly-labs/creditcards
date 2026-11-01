import { createHash } from "node:crypto"
import { Schema } from "effect"
import type { Hold } from "../model/holds.ts"
import { Card } from "../model/schema.ts"
import type { Offer } from "../offers/schema.ts"
import { encodeJson } from "../util/json.ts"
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

export const SIGNUP_INCREASE_HOLD = 1.5

const signupPoints = (offer: Offer | undefined) =>
  offer?.components.reduce((sum, component) => sum + (component.kind === "signup_points" ? component.points : 0), 0) ??
  0

const offerCandidates = (existing: Card, proposed: Card): ReadonlyArray<HoldCandidate> => {
  const candidates: Array<HoldCandidate> = []

  for (const before of existing.offers ?? []) {
    const after = proposed.offers?.find((offer) => offer.id === before.id)

    if (after === undefined && before.source !== "manual") {
      candidates.push({
        change: `${OFFER_PREFIX}${before.id}`,
        reason: `offer ${before.id} is no longer in CDR`,
        kind: "confirm",
        current: before,
        proposed: undefined
      })
      continue
    }

    const [was, now] = [signupPoints(before), signupPoints(after)]

    if (was > 0 && now > was * SIGNUP_INCREASE_HOLD) {
      candidates.push({
        change: `${OFFER_PREFIX}${before.id}`,
        reason: `signup points ${was} → ${now}`,
        kind: "approve",
        current: before,
        proposed: after
      })
    }
  }

  return candidates
}

export const holdCandidates = (existing: Card, proposed: Card): ReadonlyArray<HoldCandidate> => [
  ...heldFields(diffCard(existing, proposed)).map(({ path, reason }): HoldCandidate => ({
    change: path,
    reason,
    kind: "approve",
    current: getPath(existing, path),
    proposed: getPath(proposed, path)
  })),
  ...offerCandidates(existing, proposed)
]

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

export const holdId = (card: string, change: string, proposed: unknown): string =>
  createHash("sha256")
    .update(encodeJson([card, change, proposed ?? null]))
    .digest("hex")
    .slice(0, 12)

export interface Resolution {
  readonly apply: ReadonlyArray<HoldCandidate>
  readonly revert: ReadonlyArray<HoldCandidate>
  readonly holds: ReadonlyArray<Hold>
}

const asJson = (value: unknown) => (value === undefined ? undefined : encodeJson(value))

export const resolveHolds = (input: {
  readonly card: string
  readonly candidates: ReadonlyArray<HoldCandidate>
  readonly entries: ReadonlyArray<Hold>
  readonly date: string
  readonly history?: string | undefined
}): Resolution => {
  const apply: Array<HoldCandidate> = []
  const revert: Array<HoldCandidate> = []
  const holds: Array<Hold> = []

  for (const candidate of input.candidates) {
    const id = holdId(input.card, candidate.change, candidate.proposed)
    const entry = input.entries.find((hold) => hold.id === id)
    const confirmed = candidate.kind === "confirm" && entry !== undefined && entry.since < input.date

    if (entry?.decision === "approve" || (confirmed && entry.decision === undefined)) {
      apply.push(candidate)
      continue
    }

    revert.push(candidate)
    const current = asJson(candidate.current)
    const proposed = asJson(candidate.proposed)

    holds.push(
      entry ?? {
        id,
        card: input.card,
        change: candidate.change,
        kind: candidate.kind,
        reason: candidate.reason,
        ...(current === undefined ? {} : { current }),
        ...(proposed === undefined ? {} : { proposed }),
        since: input.date,
        ...(input.history === undefined ? {} : { history: input.history })
      }
    )
  }

  return { apply, revert, holds }
}
