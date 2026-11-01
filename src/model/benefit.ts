import type { EarnRate } from "./schema.ts"

const isBaseRate = (e: EarnRate) => e.category == null || e.category === ""

export const annualPoints = (earn: ReadonlyArray<EarnRate>, monthlySpend: number): number | undefined => {
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
