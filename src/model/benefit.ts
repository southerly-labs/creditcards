import { ruleAnnualPoints, type EarnRule } from "./earn.ts"
import type { EarnRate } from "./schema.ts"

const isBaseRate = (e: EarnRate) => e.category == null || e.category === ""

export const annualPoints = (
  earn: ReadonlyArray<EarnRate>,
  monthlySpend: number,
  rules?: ReadonlyArray<EarnRule>
): number | undefined => {
  if (rules !== undefined) return ruleAnnualPoints(rules, monthlySpend)
  const tiers = earn.filter((e) => isBaseRate(e))

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

export const meetsSpendTarget = (
  monthlySpend: number,
  target: { readonly min_spend?: number; readonly spend_days?: number }
): boolean => {
  if (target.min_spend === undefined) return true
  const days = target.spend_days ?? 365

  return (monthlySpend * 12 * days) / 365 >= target.min_spend
}
