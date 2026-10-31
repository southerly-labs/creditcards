import type { Card } from "../model/schema.ts"
import type { NormalisedCard } from "../cdr/normalise.ts"

// Field paths the CDR sync owns. Anything else (e.g. rewards.earn) is curated
// by hand or by other extractors and is never touched by the CDR sync.
export const CDR_OWNED_PATHS = [
  "name", "type", "network", "description", "url", "image", "cdr",
  "fees.annual", "fees.annual_first_year", "fees.additional_card", "fees.foreign_txn_pct",
  "fees.cash_advance_pct", "fees.cash_advance_min", "fees.late_payment",
  "rates.purchase", "rates.cash_advance", "rates.balance_transfer", "rates.interest_free_days", "rates.intro",
  "limits.min_credit", "limits.max_credit", "limits.min_income",
  "rewards.program", "rewards.partners", "rewards.bonus_points",
  "perks.insurance", "perks.lounge_access"
] as const

type Obj = Record<string, unknown>

const getPath = (obj: Obj, path: string): unknown =>
  path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Obj)[k] : undefined), obj)

const setPath = (obj: Obj, path: string, value: unknown) => {
  const keys = path.split(".")
  let target = obj
  for (const k of keys.slice(0, -1)) {
    if (!target[k] || typeof target[k] !== "object") target[k] = {}
    target = target[k] as Obj
  }
  const last = keys[keys.length - 1]!
  if (value === undefined) delete target[last]
  else target[last] = value
}

const isLocked = (locked: ReadonlyArray<string>, path: string) =>
  locked.some((l) => path === l || path.startsWith(`${l}.`) || l.startsWith(`${path}.`))

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export const mergeCard = (existing: Card | undefined, incoming: NormalisedCard): Obj => {
  if (!existing) return structuredClone(incoming) as Obj
  const merged = structuredClone(existing) as Obj
  const locked = existing.locked ?? []
  for (const path of CDR_OWNED_PATHS) {
    if (isLocked(locked, path)) continue
    setPath(merged, path, structuredClone(getPath(incoming as Obj, path)))
  }
  merged.status = "active"
  delete merged.discontinued
  // A rewards table without a program is invalid: the card no longer has a
  // loyalty program, so drop the table unless a human has locked it.
  const rewards = merged.rewards as Obj | undefined
  if (rewards && rewards.program === undefined && !isLocked(locked, "rewards")) delete merged.rewards
  return merged
}

export interface FieldChange {
  readonly path: string
  readonly before: unknown
  readonly after: unknown
}

// Some data holders bump cdr.last_updated on every request, so it alone is
// not a change. It is still written whenever something else changes.
const withoutTimestamp = (path: string, value: unknown) => {
  if (path !== "cdr" || !value || typeof value !== "object") return value
  const { last_updated: _, ...rest } = value as Obj
  return rest
}

export const diffCard = (before: Card | undefined, after: Obj): ReadonlyArray<FieldChange> => {
  const paths = [...CDR_OWNED_PATHS, "status", "discontinued", ...EARN_PATHS]
  return paths
    .map((path) => ({ path, before: before ? getPath(before as Obj, path) : undefined, after: getPath(after, path) }))
    .filter((c) => !equal(withoutTimestamp(c.path, c.before), withoutTimestamp(c.path, c.after)))
}

// Written by the earn-rate parser (src/rewards), not the CDR merge.
export const EARN_PATHS = ["rewards.earn", "rewards.earn_source", "rewards.earn_text_hash"] as const

// ---- Guardrails ---------------------------------------------------------------
// Auto-merge is only safe if implausible changes are held back for a human.

const KEY_FIELDS = ["fees.annual", "rates.purchase", "fees.foreign_txn_pct"]

export const holdReasons = (changes: ReadonlyArray<FieldChange>): ReadonlyArray<string> => {
  const reasons: Array<string> = []
  for (const { path, before, after } of changes) {
    if (KEY_FIELDS.includes(path) && before !== undefined && after === undefined) {
      reasons.push(`${path} disappeared (was ${before})`)
      continue
    }
    if (path === "rewards.earn" && Array.isArray(before) && Array.isArray(after)) {
      const base = (earn: ReadonlyArray<{ rate: number; category?: string }>) => earn.find((e) => !e.category)?.rate
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

// Share of an issuer's active cards that may vanish in one run before the
// discontinuations are held as a probable data-holder outage.
export const MAX_DISCONTINUED_SHARE = 0.5
// Minimum share of previously active CDR cards a run must see to proceed at all.
export const MIN_SEEN_SHARE = 0.8
