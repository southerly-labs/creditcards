import { BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Array as EffectArray, Option } from "effect"
import type { NormalisedCard } from "../../src/cdr/normalise.ts"
import { initialLifecycle } from "../../src/machine/cardLifecycle.ts"
import { LockEvent, LockState, stepLock } from "../../src/machine/sectionLock.ts"
import type { Card, FieldGap } from "../../src/model/schema.ts"
import { combineOffers } from "../../src/offers/build.ts"
import type { Offer } from "../../src/offers/schema.ts"
import { getPath, mergeCard, observeMergedGaps } from "../../src/sync/merge.ts"
import { tlaModule, tlaRows } from "./tla.ts"

const HAND = 99
const CDR = 250

const LOCKS = ["none", "exact", "section", "unrelated"] as const

type Lock = (typeof LOCKS)[number]

const lockPaths = (lock: Lock): ReadonlyArray<string> => {
  if (lock === "none") return []

  if (lock === "exact") return ["fees.annual"]

  return lock === "section" ? ["fees"] : ["rates.purchase"]
}

const GAP: FieldGap = { field: "fees.annual", reason: "not_stated", checked: "2026-11-01", sources: ["cdr"] }

const storedCard = (lock: Lock, hand: boolean, gap: boolean): Card => {
  const locked = lockPaths(lock)

  return {
    name: "Card",
    type: "personal",
    first_seen: "2026-11-01",
    lifecycle: initialLifecycle,
    fees: hand ? { annual: HAND } : {},
    rates: {},
    limits: {},
    perks: {},
    ...(locked.length === 0 ? {} : { locked }),
    ...(gap ? { gaps: [GAP] } : {})
  }
}

const incomingCard = (cdr: boolean): NormalisedCard => ({
  name: "Card",
  type: "personal",
  lifecycle: initialLifecycle,
  fees: cdr ? { annual: CDR } : {},
  rates: {},
  limits: {},
  perks: {}
})

const valueName = (value: unknown): string => {
  if (value === undefined) return "none"

  return value === HAND ? "hand" : "cdr"
}

const mergeRow = Effect.fn("mergeRow")(function* (lock: Lock, hand: boolean, cdr: boolean, gap: boolean) {
  const existing = storedCard(lock, hand, gap)
  const merged = mergeCard(existing, incomingCard(cdr))

  yield* observeMergedGaps(merged, existing)

  return [lock, hand, cdr, gap, valueName(getPath(merged, "fees.annual")), getPath(merged, "gaps") !== undefined]
})

const offerOf = (source: "cdr" | "manual", points: number): Offer => ({
  id: "signup",
  source,
  components: [{ kind: "signup_points", program: "points", points }]
})

const EXISTING = ["none", "cdr", "manual"] as const

const offerName = (offers: ReadonlyArray<Offer>): string => {
  const signup = Option.getOrUndefined(EffectArray.findFirst(offers, (offer) => offer.id === "signup"))

  if (signup === undefined) return "none"

  if (signup.source === "manual") return "manual"

  return signup.components[0]?.kind === "signup_points" && signup.components[0].points === 2000 ? "new" : "old"
}

const slotRow = Effect.fn("slotRow")(function* (
  existing: (typeof EXISTING)[number],
  generated: boolean,
  locked: boolean
) {
  const offers = yield* combineOffers({
    existing: existing === "none" ? [] : [offerOf(existing, 1000)],
    generated: generated ? [offerOf("cdr", 2000)] : [],
    locked
  })

  return [existing, generated, locked, offerName(offers)]
})

const LOCK_STATES = ["Unlocked", "Fresh", "Stale", "Undated"] as const

const lockStateOf = (tag: (typeof LOCK_STATES)[number]): LockState => {
  if (tag === "Unlocked") return LockState.cases.Unlocked.make({})

  if (tag === "Fresh") return LockState.cases.Fresh.make({ reviewed_at: "2026-11-01T00:00:00Z" })

  return tag === "Stale"
    ? LockState.cases.Stale.make({ reviewed_at: "2026-01-01T00:00:00Z" })
    : LockState.cases.Undated.make({})
}

const LOCK_EVENTS = ["Correct", "Unlock", "AgedYoung", "AgedOld"] as const

const lockEventOf = (event: (typeof LOCK_EVENTS)[number]): LockEvent => {
  if (event === "Correct") return LockEvent.cases.Correct.make({ reviewed_at: "2026-11-02T00:00:00Z" })

  if (event === "Unlock") return LockEvent.cases.Unlock.make({})

  return LockEvent.cases.Aged.make({ now: event === "AgedYoung" ? "2026-11-03T00:00:00Z" : "2027-06-01T00:00:00Z" })
}

const lockRow = Effect.fn("lockRow")(function* (
  tag: (typeof LOCK_STATES)[number],
  event: (typeof LOCK_EVENTS)[number]
) {
  const next = yield* stepLock(lockStateOf(tag), lockEventOf(event))

  return [tag, event, next._tag]
})

const program = Effect.gen(function* () {
  const mergeRows = yield* Effect.forEach(
    EffectArray.flatMap(LOCKS, (lock) =>
      EffectArray.flatMap([true, false], (hand) =>
        EffectArray.flatMap([true, false], (cdr) =>
          EffectArray.map([true, false], (gap) => [lock, hand, cdr, gap] as const)
        )
      )
    ),
    ([lock, hand, cdr, gap]) => mergeRow(lock, hand, cdr, gap)
  )

  const slotRows = yield* Effect.forEach(
    EffectArray.flatMap(EXISTING, (existing) =>
      EffectArray.flatMap([true, false], (generated) =>
        EffectArray.map([true, false], (locked) => [existing, generated, locked] as const)
      )
    ),
    ([existing, generated, locked]) => slotRow(existing, generated, locked)
  )

  const lockRows = yield* Effect.forEach(
    EffectArray.flatMap(LOCK_STATES, (tag) => EffectArray.map(LOCK_EVENTS, (event) => [tag, event] as const)),
    ([tag, event]) => lockRow(tag, event)
  )

  yield* Console.log(
    tlaModule(
      "ManualOverridesCode",
      [
        "src/sync/merge.ts (mergeCard, observeMergedGaps)",
        "src/machine/fieldGap.ts",
        "src/offers/build.ts (combineOffers)",
        "src/machine/offerSlot.ts",
        "src/machine/sectionLock.ts"
      ],
      [tlaRows("MergeRows", mergeRows), tlaRows("SlotRows", slotRows), tlaRows("LockRows", lockRows)]
    )
  )
})

BunRuntime.runMain(program)
