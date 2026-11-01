import { encodeJson } from "../util/json.ts"
import { Data, Predicate } from "effect"
import { required } from "../util/required.ts"
import type { Card } from "../model/schema.ts"
import type { NormalisedCard } from "../cdr/normalise.ts"

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

const getPath = (obj: Obj, path: string): unknown =>
  path.split(".").reduce<unknown>((o, k) => (Predicate.isObject(o) ? o[k] : undefined), obj)

const setPath = (obj: Obj, path: string, value: unknown) => {
  const keys = path.split(".")
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

const isLocked = (locked: ReadonlyArray<string>, path: string) =>
  locked.some((l) => path === l || path.startsWith(`${l}.`) || l.startsWith(`${path}.`))

const equal = (a: unknown, b: unknown) =>
  a === undefined || b === undefined ? a === b : encodeJson(a) === encodeJson(b)

export const mergeCard = (existing: Card | undefined, incoming: NormalisedCard): Obj => {
  if (!existing) return structuredClone(incoming)
  const merged: Obj = structuredClone(existing)
  const locked = existing.locked ?? []

  for (const path of CDR_OWNED_PATHS) {
    if (isLocked(locked, path)) continue
    setPath(merged, path, structuredClone(getPath(incoming, path)))
  }

  merged["status"] = existing.status === "closed" ? "closed" : "active"
  delete merged["discontinued"]
  delete merged["missing_since"]

  const rewards = merged["rewards"]

  if (Predicate.isObject(rewards) && rewards["program"] === undefined && !isLocked(locked, "rewards"))
    delete merged["rewards"]

  return merged
}

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

export const diffCard = (before: Card | undefined, after: Obj): ReadonlyArray<FieldChange> => {
  const paths = [...CDR_OWNED_PATHS, "status", "discontinued", "missing_since", ...EARN_PATHS, ...OFFER_PATHS]

  return paths
    .values()
    .map((path) => ({ path, before: before ? getPath(before, path) : undefined, after: getPath(after, path) }))
    .filter((c) => !equal(withoutTimestamp(c.path, c.before), withoutTimestamp(c.path, c.after)))
    .toArray()
}

export const EARN_PATHS = ["rewards.earn", "rewards.earn_source", "rewards.earn_text_hash"] as const

export const OFFER_PATHS = ["offers", "signup_review"] as const

const KEY_FIELDS = new Set(["fees.annual", "rates.purchase", "fees.foreign_txn_pct"])

export const holdReasons = (changes: ReadonlyArray<FieldChange>): ReadonlyArray<string> => {
  const reasons: Array<string> = []

  for (const { path, before, after } of changes) {
    if (KEY_FIELDS.has(path) && before !== undefined && after === undefined) {
      reasons.push(`${path} disappeared (was ${encodeJson(before)})`)
      continue
    }

    if (path === "rewards.earn" && Array.isArray(before) && Array.isArray(after)) {
      const base = (earn: ReadonlyArray<{ rate: number; category?: string }>) =>
        earn.find((e) => e.category == null || e.category === "")?.rate

      const [b, a] = [base(before), base(after)]

      if (b !== undefined && a !== undefined && Math.abs(a - b) > 1) reasons.push(`base earn rate ${b} → ${a}`)
      continue
    }

    if (typeof before !== "number" || typeof after !== "number") continue
    const delta = Math.abs(after - before)

    if (path === "fees.annual" && delta > 100 && delta / Math.max(before, 1) > 0.5) {
      reasons.push(`${path} ${before} → ${after}`)
    } else if (path.startsWith("rates.") && path !== "rates.interest_free_days" && delta > 5) {
      reasons.push(`${path} ${before}% → ${after}%`)
    } else if (path === "fees.foreign_txn_pct" && delta > 2) {
      reasons.push(`${path} ${before}% → ${after}%`)
    }
  }

  return reasons
}

export const MAX_DISCONTINUED_SHARE = 0.5

export type MissingStep =
  | { readonly _tag: "Mark" }
  | { readonly _tag: "Wait" }
  | { readonly _tag: "Discontinue"; readonly since: string }

export const MissingStep = Data.taggedEnum<MissingStep>()

export const missingStep = (card: Card, date: string): MissingStep => {
  if (card.missing_since === undefined) return MissingStep.Mark()

  return card.missing_since < date ? MissingStep.Discontinue({ since: card.missing_since }) : MissingStep.Wait()
}

export const MIN_SEEN_SHARE = 0.8
