import { describe, expect, test } from "@effect/vitest"
import { type SyncReport, summariseRewardsReview } from "../src/sync/Sync.ts"

const report = (earn: number, bonus: number): SyncReport => ({
  date: "2026-11-01",
  cardsSeen: 1,
  added: [],
  updated: [],
  discontinued: [],
  held: [],
  newIssuers: [],
  newPrograms: [],
  brandErrors: [],
  snapshotsSaved: 0,
  rewards: { set: [], review: Array.from({ length: earn }, (_, i) => ({ card: `a/earn-${i}`, reason: "r" })) },
  bonus: { set: [], review: Array.from({ length: bonus }, (_, i) => ({ card: `a/bonus-${i}`, reason: "r" })) }
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

  test("says so when nothing needs review", () => {
    expect(summariseRewardsReview(report(0, 0))).toBe("No earn rates or signup bonuses need review (sync 2026-11-01).")
  })
})
