import { sha256Prefix } from "../util/hash.ts"
import type { Digest } from "effect/crypto"
import { Schema, String as EffectString, Array as EffectArray, pipe, Option, Effect } from "effect"
import type { Hold } from "../model/holds.ts"
import {
  HoldEvent,
  type HoldKind,
  HoldOutcome,
  type HoldState,
  isPending,
  pendingState,
  stepHold
} from "../machine/hold.ts"
import { Card, EarnRate } from "../model/schema.ts"
import { Offer } from "../offers/schema.ts"
import { encodeJson } from "../util/json.ts"
import { diffCard, getPath, heldFields, setPath } from "./merge.ts"
import { dual } from "effect/Function"

export type { HoldKind }

export interface HoldCandidate {
  readonly change: string
  readonly reason: string
  readonly kind: HoldKind
  readonly current: unknown
  readonly proposed: unknown
  readonly evidence?: string
}

const REVERTED_WITH: Readonly<Record<string, ReadonlyArray<string>>> = {
  "rewards.earn": ["rewards.earn", "rewards.earn_source", "rewards.earn_text_hash", "rewards.earn_review"]
}

const OFFER_PREFIX = "offers."

export const SIGNUP_INCREASE_HOLD = 1.5

const signupPoints = (offer: Offer | undefined) =>
  EffectArray.reduce(
    offer?.components ?? [],
    0,
    (sum, component) => sum + (component.kind === "signup_points" ? component.points : 0)
  )

const offerCandidates = (existing: Card, proposed: Card): ReadonlyArray<HoldCandidate> => {
  const candidates: Array<HoldCandidate> = []

  for (const before of existing.offers ?? []) {
    const after = Option.getOrUndefined(EffectArray.findFirst(proposed.offers ?? [], (offer) => offer.id === before.id))

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

export const holdCandidates = Effect.fn("holdCandidates")(function* (existing: Card, proposed: Card) {
  const fields = yield* heldFields(yield* diffCard(existing, proposed))

  return [
    ...EffectArray.map(fields, ({ path, reason }): HoldCandidate => ({
      change: path,
      reason,
      kind: "approve",
      current: getPath(existing, path),
      proposed: getPath(proposed, path)
    })),
    ...offerCandidates(existing, proposed)
  ]
})

const revertOffer = (card: Card, existing: Card, id: string): Card => {
  const before = Option.getOrUndefined(EffectArray.findFirst(existing.offers ?? [], (offer) => offer.id === id))
  const after = card.offers ?? []
  const kept = EffectArray.flatMap(after, (offer) => (offer.id !== id ? [offer] : before === undefined ? [] : [before]))
  const offers = before !== undefined && !EffectArray.some(after, (offer) => offer.id === id) ? [...kept, before] : kept
  const { offers: _offers, signup_review: _review, ...rest } = card
  const review = id === "signup" ? existing.signup_review : card.signup_review

  return {
    ...rest,
    ...(offers.length === 0 ? {} : { offers }),
    ...(review === undefined ? {} : { signup_review: review })
  }
}

export const valueAt = dual<(change: string) => (card: Card) => unknown, (card: Card, change: string) => unknown>(
  2,
  (card: Card, change: string): unknown =>
    pipe(change, EffectString.startsWith(OFFER_PREFIX))
      ? Option.getOrUndefined(
          EffectArray.findFirst(
            card.offers ?? [],
            (offer) => offer.id === pipe(change, EffectString.slice(OFFER_PREFIX.length))
          )
        )
      : getPath(card, change)
)

const isEarn = Schema.is(Schema.Array(EarnRate))

const isOffer = Schema.is(Offer)

const baseEarn = (value: unknown) =>
  isEarn(value)
    ? Option.getOrUndefined(EffectArray.findFirst(value, (e) => e.category == null || e.category === ""))?.rate
    : undefined

const PLAUSIBLE: Readonly<Record<string, (value: unknown) => boolean>> = {
  "fees.annual": (v) => typeof v === "number" && v >= 0 && v <= 2500,
  "fees.foreign_txn_pct": (v) => typeof v === "number" && v >= 0 && v <= 5,
  "rates.purchase": (v) => typeof v === "number" && v > 0 && v <= 40,
  "rates.cash_advance": (v) => typeof v === "number" && v > 0 && v <= 40,
  "rates.balance_transfer": (v) => typeof v === "number" && v >= 0 && v <= 40,
  "rewards.earn": (v) => {
    const rate = baseEarn(v)

    return rate !== undefined && rate > 0 && rate <= 10
  },
  "offers.signup": (v) => {
    const points = signupPoints(isOffer(v) ? v : undefined)

    return points > 0 && points <= 500_000
  }
}

export const CONFIRMED_BY_CDR = "the issuer's CDR data changed"

export const withCdrEvidence = Effect.fn("withCdrEvidence")(function* (
  candidate: HoldCandidate,
  previous: { readonly date: string; readonly card: Card } | undefined
) {
  if (candidate.kind !== "approve" || previous === undefined || candidate.proposed === undefined) return candidate

  const before = yield* encodeJson(valueAt(previous.card, candidate.change) ?? null)
  const current = yield* encodeJson(candidate.current ?? null)
  const proposed = yield* encodeJson(candidate.proposed)

  if (before !== current || before === proposed || PLAUSIBLE[candidate.change]?.(candidate.proposed) !== true)
    return candidate

  return {
    ...candidate,
    kind: "confirm",
    reason: `${candidate.reason}; ${CONFIRMED_BY_CDR} since ${previous.date}`,
    evidence: `CDR snapshot ${previous.date} gives ${before}; today's gives ${proposed}`
  } satisfies HoldCandidate
})

const isCard = Schema.is(Card)

const revertChangeImpl = (card: Card, existing: Card, change: string): Card | undefined => {
  if (pipe(change, EffectString.startsWith(OFFER_PREFIX)))
    return revertOffer(card, existing, pipe(change, EffectString.slice(OFFER_PREFIX.length)))
  const reverted: Record<string, unknown> = structuredClone(card)

  for (const path of REVERTED_WITH[change] ?? [change])
    setPath(reverted, path, structuredClone(getPath(existing, path)))

  return isCard(reverted) ? reverted : undefined
}

export const revertChange = dual<
  (existing: Card, change: string) => (card: Card) => Card | undefined,
  (card: Card, existing: Card, change: string) => Card | undefined
>(3, revertChangeImpl)

export const holdId = dual<
  (change: string, proposed: unknown) => (card: string) => Effect.Effect<string, never, Digest.Digest>,
  (card: string, change: string, proposed: unknown) => Effect.Effect<string, never, Digest.Digest>
>(3, (card: string, change: string, proposed: unknown): Effect.Effect<string, never, Digest.Digest> =>
  encodeJson([card, change, proposed ?? null]).pipe(Effect.flatMap((json) => sha256Prefix(json, 12)))
)

export interface Resolution {
  readonly apply: ReadonlyArray<HoldCandidate>
  readonly revert: ReadonlyArray<HoldCandidate>
  readonly holds: ReadonlyArray<Hold>
}

const asJson = Effect.fn("asJson")(function* (value: unknown) {
  return value === undefined ? undefined : yield* encodeJson(value)
})

const newHold = Effect.fn("newHold")(function* (input: {
  readonly id: string
  readonly card: string
  readonly candidate: HoldCandidate
  readonly date: string
  readonly history?: string | undefined
}) {
  const { id, card, candidate, date, history } = input
  const current = yield* asJson(candidate.current)
  const proposed = yield* asJson(candidate.proposed)

  return {
    id,
    card,
    change: candidate.change,
    reason: candidate.reason,
    ...(current === undefined ? {} : { current }),
    ...(proposed === undefined ? {} : { proposed }),
    since: date,
    ...(history === undefined ? {} : { history }),
    ...(candidate.evidence === undefined ? {} : { cdr_evidence: candidate.evidence }),
    state: pendingState(candidate.kind)
  } satisfies Hold
})

const heldAs = (entry: Hold, candidate: HoldCandidate, state: HoldState): Hold => {
  if (entry.state._tag === state._tag) return entry
  const { cdr_evidence: _evidence, ...rest } = entry

  return isPending(state)
    ? {
        ...rest,
        reason: candidate.reason,
        ...(candidate.evidence === undefined ? {} : { cdr_evidence: candidate.evidence }),
        state
      }
    : { ...entry, state }
}

export const resolveHolds = Effect.fn("resolveHolds")(function* (input: {
  readonly card: string
  readonly candidates: ReadonlyArray<HoldCandidate>
  readonly entries: ReadonlyArray<Hold>
  readonly date: string
  readonly history?: string | undefined
}) {
  const apply: Array<HoldCandidate> = []
  const revert: Array<HoldCandidate> = []
  const holds: Array<Hold> = []
  const proposedIds = new Set<string>()

  for (const candidate of input.candidates) {
    const id = yield* holdId(input.card, candidate.change, candidate.proposed)
    proposedIds.add(id)
    const entry = Option.getOrUndefined(EffectArray.findFirst(input.entries, (hold) => hold.id === id))

    if (entry === undefined) {
      revert.push(candidate)
      holds.push(yield* newHold({ id, card: input.card, candidate, date: input.date, history: input.history }))
      continue
    }

    const outcome = yield* stepHold(
      entry.state,
      HoldEvent.cases.Proposed.make({ kind: candidate.kind, today: input.date, since: entry.since })
    )

    if (HoldOutcome.guards.Held(outcome)) {
      revert.push(candidate)
      holds.push(heldAs(entry, candidate, outcome.state))
    } else apply.push(candidate)
  }

  for (const entry of input.entries) {
    if (proposedIds.has(entry.id)) continue
    const outcome = yield* stepHold(entry.state, HoldEvent.cases.Withdrawn.make({}))

    if (HoldOutcome.guards.Held(outcome)) holds.push({ ...entry, state: outcome.state })
  }

  return { apply, revert, holds } satisfies Resolution
})
