import { describe, expect, test } from "@effect/vitest"
import { annualPoints } from "../src/model/benefit.ts"
import type { EarnRule } from "../src/model/earn.ts"

const base: EarnRule = {
  rate: 2,
  treatment: "replacement",
  category: { id: "general", description: "Eligible general purchases" }
}

describe("explicit earn semantics", () => {
  test("additional earn stacks on replacement earn", () => {
    expect(annualPoints([], 100, [base, { ...base, rate: 1, treatment: "additional" }])).toBe(3600)
  })
  test("points caps differ from spend caps", () => {
    expect(annualPoints([], 100, [{ ...base, cap: { amount: 100, unit: "points", period: "statement" } }])).toBe(1200)
    expect(annualPoints([], 100, [{ ...base, cap: { amount: 100, unit: "spend", period: "statement" } }])).toBe(2400)
  })
  test("annual caps apply once", () => {
    expect(annualPoints([], 100, [{ ...base, cap: { amount: 100, unit: "points", period: "membership-year" } }])).toBe(
      100
    )
  })
  test("unsupported rules cannot silently fall back to optimistic legacy estimates", () => {
    expect(
      annualPoints([{ rate: 5 }], 100, [{ ...base, category: { id: "dining", description: "Dining purchases" } }])
    ).toBeUndefined()
    expect(
      annualPoints([{ rate: 5 }], 100, [
        { ...base, cap: { amount: 100, unit: "points", period: "statement", shared_group: "all" } }
      ])
    ).toBeUndefined()
    expect(annualPoints([], 100, [base, base])).toBeUndefined()
    expect(annualPoints([], 100, [{ ...base, treatment: "additional" }])).toBeUndefined()
  })
})
