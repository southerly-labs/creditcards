import { ruleAnnualPoints, type EarnRule } from "./earn.ts"
import type { EarnRate } from "./schema.ts"
import { Array as EffectArray } from "effect"
import { dual } from "effect/Function"

const isBaseRate = (e: EarnRate) => e.category == null || e.category === ""

const annualPointsImpl = (
  earn: ReadonlyArray<EarnRate>,
  monthlySpend: number,
  rules?: ReadonlyArray<EarnRule>
): number | undefined => {
  if (rules !== undefined) return ruleAnnualPoints(rules, monthlySpend)
  const tiers = EffectArray.filter(earn, (e) => isBaseRate(e))

  if (tiers.length === 0) return undefined
  let floor = 0
  let points = 0

  for (const tier of tiers) {
    const ceiling = tier.cap_monthly ?? (tier.cap_annual === undefined ? Infinity : tier.cap_annual / 12)
    const spend = Math.max(0, Math.min(monthlySpend, ceiling) - floor)
    points += spend * tier.rate
    floor = Math.max(floor, ceiling)

    if (floor >= monthlySpend) break
  }

  return Math.round(points * 12)
}

export const annualPoints = dual<
  (monthlySpend: number, rules?: ReadonlyArray<EarnRule>) => (earn: ReadonlyArray<EarnRate>) => number | undefined,
  (earn: ReadonlyArray<EarnRate>, monthlySpend: number, rules?: ReadonlyArray<EarnRule>) => number | undefined
>((args) => typeof args[1] === "number", annualPointsImpl)

const meetsSpendTargetImpl = (
  monthlySpend: number,
  target: { readonly min_spend?: number; readonly spend_days?: number }
): boolean => {
  if (target.min_spend === undefined) return true
  const days = target.spend_days ?? 365

  return (monthlySpend * 12 * days) / 365 >= target.min_spend
}

export const meetsSpendTarget = dual<
  (target: { readonly min_spend?: number; readonly spend_days?: number }) => (monthlySpend: number) => boolean,
  (monthlySpend: number, target: { readonly min_spend?: number; readonly spend_days?: number }) => boolean
>(2, meetsSpendTargetImpl)
