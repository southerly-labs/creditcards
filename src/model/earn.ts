import { Schema } from "effect"

const Amount = Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100_000_000 })))
const Id = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)))

export const EarnRule = Schema.Struct({
  rate: Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 20 }))),
  treatment: Schema.Literals(["replacement", "additional"]),
  category: Schema.Struct({ id: Id, description: Schema.NonEmptyString }),
  cap: Schema.optionalKey(
    Schema.Struct({
      amount: Amount,
      unit: Schema.Literals(["spend", "points"]),
      period: Schema.Literals(["statement", "calendar-month", "calendar-year", "membership-year"]),
      shared_group: Schema.optionalKey(Id)
    })
  )
})

export type EarnRule = typeof EarnRule.Type

export const ruleAnnualPoints = (rules: ReadonlyArray<EarnRule>, monthlySpend: number): number | undefined => {
  if (!Number.isFinite(monthlySpend) || monthlySpend < 0 || rules.length === 0) return undefined

  if (rules.some((rule) => rule.category.id !== "general" || rule.cap?.shared_group !== undefined)) return undefined

  if (rules.filter((rule) => rule.treatment === "replacement").length !== 1) return undefined

  let points = 0

  for (const rule of rules) {
    const periods = rule.cap?.period === "calendar-year" || rule.cap?.period === "membership-year" ? 1 : 12
    const spend = (monthlySpend * 12) / periods
    const cap = rule.cap
    const earned = cap?.unit === "spend" ? Math.min(spend, cap.amount) * rule.rate : spend * rule.rate
    points += (cap?.unit === "points" ? Math.min(earned, cap.amount) : earned) * periods
  }

  return Math.round(points)
}
