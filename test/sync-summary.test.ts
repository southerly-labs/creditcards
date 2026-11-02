import { describe, expect, test } from "@effect/vitest"
import { type SyncReport, summariseReport, summariseRewardsReview } from "../src/sync/Sync.ts"

const report = (earn: number, bonus: number, undetailed: ReadonlyArray<string> = []): SyncReport => ({
  date: "2026-11-01",
  cardsSeen: 1,
  added: [],
  updated: [],
  discontinued: [],
  missing: [],
  held: [],
  holds: [],
  released: [],
  newIssuers: [],
  newPrograms: [],
  brandErrors: [],
  cardlessBrandErrors: 0,
  snapshotsSaved: 0,
  rewards: { set: [], review: Array.from({ length: earn }, (_, i) => ({ card: `a/earn-${i}`, reason: "r" })) },
  bonus: {
    set: [],
    review: Array.from({ length: bonus }, (_, i) => ({ card: `a/bonus-${i}`, reason: "r" })),
    undetailed
  }
})

describe("review issue body", () => {
  test("leaves out the earn section when no earn rates need review", () => {
    const body = summariseRewardsReview(report(0, 2))
    expect(body).not.toContain("earn rates the parser")
    expect(body.startsWith("2 cards have signup bonuses")).toBe(true)
  })

  test("leaves out the bonus section when no bonuses need review", () => {
    const body = summariseRewardsReview(report(1, 0))
    expect(body).toContain("`a/earn-0`")
    expect(body).not.toContain("signup bonuses")
  })

  test("counts offers named without details instead of listing them", () => {
    const undetailed = report(0, 0, ["amex/platinum-card"])
    expect(summariseRewardsReview(undetailed)).not.toContain("amex/platinum-card")
    expect(summariseReport(undetailed)).toContain("0 need review, 1 named in CDR without details")
  })

  test("says so when nothing needs review", () => {
    expect(summariseRewardsReview(report(0, 0))).toBe("No earn rates or signup bonuses need review (sync 2026-11-01).")
  })
})
