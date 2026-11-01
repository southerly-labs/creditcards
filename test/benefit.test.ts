import { describe, expect, test } from "@effect/vitest"
import { annualPoints } from "../src/model/benefit.ts"

describe("annual points from monthly spend", () => {
  test("single uncapped rate", () => {
    expect(annualPoints([{ rate: 1.5 }], 2000)).toBe(36000)
  })

  test("first tier up to a cap, then a lower rate thereafter", () => {
    expect(annualPoints([{ rate: 1, cap_monthly: 3000 }, { rate: 0.2 }], 5000)).toBe(12 * (3000 + 400))
  })

  test("spend below the first cap earns only the first tier", () => {
    expect(annualPoints([{ rate: 1, cap_monthly: 3000 }, { rate: 0.2 }], 1000)).toBe(12000)
  })

  test("no points above a hard ceiling", () => {
    expect(
      annualPoints(
        [
          { rate: 1, cap_monthly: 7500 },
          { rate: 0.5, cap_monthly: 50000 }
        ],
        60000
      )
    ).toBe(12 * (7500 + 0.5 * 42500))
  })

  test("category rates are ignored", () => {
    expect(annualPoints([{ rate: 0.5 }, { rate: 2, category: "international spend" }], 1000)).toBe(6000)
  })

  test("no base rate means unknown", () => {
    expect(annualPoints([{ rate: 2, category: "dining" }], 1000)).toBeUndefined()
  })
})
