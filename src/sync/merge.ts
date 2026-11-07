import { encodeJson, jsonEqual } from "../util/json.ts"
import { Effect, Option, Predicate, Array as EffectArray, String as EffectString, pipe } from "effect"
import { required } from "../util/required.ts"
import type { Card } from "../model/schema.ts"
import type { NormalisedCard } from "../cdr/normalise.ts"
import { dual } from "effect/Function"

export const CDR_OWNED_PATHS = [
  "name",
  "type",
  "network",
  "description",
  "url",
  "image",
  "cdr",
  "fees.annual",
  "fees.additional_card",
  "fees.foreign_txn_pct",
  "fees.cash_advance_pct",
  "fees.cash_advance_min",
  "fees.late_payment",
  "rates.purchase",
  "rates.cash_advance",
  "rates.balance_transfer",
  "rates.interest_free_days",
  "limits.min_credit",
  "limits.max_credit",
  "limits.min_income",
  "rewards.program",
  "rewards.partners",
  "perks.insurance",
  "perks.lounge_access"
] as const

type Obj = Record<string, unknown>

export const getPath = dual<(path: string) => (obj: Obj) => unknown, (obj: Obj, path: string) => unknown>(
  2,
  (obj: Obj, path: string): unknown =>
    EffectArray.reduce<string, unknown>(EffectString.split(path, "."), obj, (o, k) =>
      Predicate.isObject(o) ? o[k] : undefined
    )
)

const setPathImpl = (obj: Obj, path: string, value: unknown): void => {
  const keys = EffectString.split(path, ".")
  let target = obj

  for (const k of keys.slice(0, -1)) {
    const next = target[k]

    if (Predicate.isObject(next)) target = next
    else {
      const child: Obj = {}
      target[k] = child
      target = child
    }
  }

  const last = required(keys.at(-1))

  if (value === undefined) delete target[last]
  else target[last] = value
}

export const setPath = dual<
  (path: string, value: unknown) => (obj: Obj) => void,
  (obj: Obj, path: string, value: unknown) => void
>(3, setPathImpl)

const isLocked = (locked: ReadonlyArray<string>, path: string) =>
  EffectArray.some(
    locked,
    (l) => path === l || pipe(path, EffectString.startsWith(`${l}.`)) || pipe(l, EffectString.startsWith(`${path}.`))
  )

const mergeCardImpl = (existing: Card | undefined, incoming: NormalisedCard): Obj => {
  if (existing === undefined) return structuredClone(incoming)
  const merged: Obj = structuredClone(existing)
  const locked = existing.locked ?? []

  for (const path of CDR_OWNED_PATHS) {
    if (isLocked(locked, path)) continue
    setPath(merged, path, structuredClone(getPath(incoming, path)))
  }

  if (existing.gaps !== undefined) {
    const gaps = EffectArray.filter(existing.gaps, (gap) => getPath(merged, gap.field) === undefined)

    if (gaps.length > 0) merged["gaps"] = gaps
    else delete merged["gaps"]
  }

  const rewards = merged["rewards"]

  if (Predicate.isObject(rewards) && rewards["program"] === undefined && !isLocked(locked, "rewards"))
    delete merged["rewards"]

  return merged
}

export const mergeCard = dual<
  (incoming: NormalisedCard) => (existing: Card | undefined) => Obj,
  (existing: Card | undefined, incoming: NormalisedCard) => Obj
>(2, mergeCardImpl)

export interface FieldChange {
  readonly path: string
  readonly before: unknown
  readonly after: unknown
}

const withoutTimestamp = (path: string, value: unknown) => {
  if (path !== "cdr" || !Predicate.isObject(value)) return value
  const { last_updated: _, ...rest } = value

  return rest
}

export const diffCard = Effect.fn("diffCard")(function* (before: Card | undefined, after: Obj) {
  const changes: Array<FieldChange> = []

  for (const path of DIFFED_PATHS) {
    const change = {
      path,
      before: before !== undefined ? getPath(before, path) : undefined,
      after: getPath(after, path)
    }

    if (!(yield* jsonEqual(withoutTimestamp(path, change.before), withoutTimestamp(path, change.after))))
      changes.push(change)
  }

  return changes
})

export const EARN_PATHS = ["rewards.earn", "rewards.earn_source", "rewards.earn_text_hash"] as const

export const OFFER_PATHS = ["offers", "signup_review"] as const

const DIFFED_PATHS = [...CDR_OWNED_PATHS, "lifecycle", ...EARN_PATHS, ...OFFER_PATHS]

const KEY_FIELDS = new Set(["fees.annual", "rates.purchase", "fees.foreign_txn_pct"])

export interface HeldField {
  readonly path: string
  readonly reason: string
}

export const heldFields = Effect.fn("heldFields")(function* (changes: ReadonlyArray<FieldChange>) {
  const reasons: Array<HeldField> = []

  for (const { path, before, after } of changes) {
    if (KEY_FIELDS.has(path) && before !== undefined && after === undefined) {
      reasons.push({ path, reason: `${path} disappeared (was ${yield* encodeJson(before)})` })
      continue
    }

    if (path === "rewards.earn" && EffectArray.isArray(before) && EffectArray.isArray(after)) {
      const base = (earn: ReadonlyArray<unknown>) =>
        pipe(
          EffectArray.findFirst(
            EffectArray.filter(earn, Predicate.isObject),
            (e) => e["category"] == null || e["category"] === ""
          ),
          Option.map((e) => e["rate"]),
          Option.filter(Predicate.isNumber),
          Option.getOrUndefined
        )

      const [b, a] = [base(before), base(after)]

      if (b !== undefined && a !== undefined && Math.abs(a - b) > 1)
        reasons.push({ path, reason: `base earn rate ${b} → ${a}` })
      continue
    }

    if (typeof before !== "number" || typeof after !== "number") continue
    const delta = Math.abs(after - before)

    if (path === "fees.annual" && delta > 100 && delta / Math.max(before, 1) > 0.5) {
      reasons.push({ path, reason: `${path} ${before} → ${after}` })
    } else if (pipe(path, EffectString.startsWith("rates.")) && path !== "rates.interest_free_days" && delta > 5) {
      reasons.push({ path, reason: `${path} ${before}% → ${after}%` })
    } else if (path === "fees.foreign_txn_pct" && delta > 2) {
      reasons.push({ path, reason: `${path} ${before}% → ${after}%` })
    }
  }

  return reasons
})

export const holdReasons = (changes: ReadonlyArray<FieldChange>) =>
  Effect.map(heldFields(changes), (fields) => EffectArray.map(fields, (held) => held.reason))

export const MAX_DISCONTINUED_SHARE = 0.5

export const MIN_SEEN_SHARE = 0.8
