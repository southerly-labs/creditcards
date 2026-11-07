import { assert, describe, it } from "@effect/vitest"
import { SourceReview, unread } from "../src/machine/review.ts"
import { earnStateOf, signupStateOf } from "../src/rewards/state.ts"

const rewards = { program: "qantas" }

describe("review state from the legacy fields", () => {
  it("reads earn review from earn_source, earn_review and earn_text_hash", () => {
    assert.deepStrictEqual(earnStateOf({}), unread)
    assert.deepStrictEqual(earnStateOf({ rewards }), unread)
    assert.deepStrictEqual(
      earnStateOf({ rewards: { ...rewards, earn: [{ rate: 1 }], earn_source: "manual", earn_text_hash: "h" } }),
      SourceReview.cases.Reviewed.make({ hash: "h", outcome: "present" })
    )
    assert.deepStrictEqual(
      earnStateOf({
        rewards: {
          ...rewards,
          earn: [],
          earn_source: "manual",
          earn_text_hash: "h",
          earn_review: { state: "none", reviewed_at: "2026-11-01" }
        }
      }),
      SourceReview.cases.Reviewed.make({ hash: "h", outcome: "none", on: "2026-11-01" })
    )
    assert.deepStrictEqual(
      earnStateOf({ rewards: { ...rewards, earn_source: "parser", earn_text_hash: "h" } }),
      SourceReview.cases.Parsed.make({ hash: "h" })
    )
    assert.deepStrictEqual(
      earnStateOf({
        rewards: { ...rewards, earn_source: "parser", earn_text_hash: "h", earn_review: { state: "unknown" } }
      }),
      SourceReview.cases.Unreadable.make({ hash: "h" })
    )
  })

  it("reads signup review from signup_review", () => {
    assert.deepStrictEqual(signupStateOf({}), unread)
    assert.deepStrictEqual(signupStateOf({ signup_review: { state: "unknown" } }), unread)
    assert.deepStrictEqual(
      signupStateOf({ signup_review: { state: "present", source: "parser", text_hash: "h" } }),
      SourceReview.cases.Parsed.make({ hash: "h" })
    )
    assert.deepStrictEqual(
      signupStateOf({ signup_review: { state: "none", source: "manual", text_hash: "h", reviewed_at: "2026-11-02" } }),
      SourceReview.cases.Reviewed.make({ hash: "h", outcome: "none", on: "2026-11-02" })
    )
  })

  it("prefers a recorded state", () => {
    const stale = SourceReview.cases.Stale.make({ hash: "h", outcome: "present" })
    assert.deepStrictEqual(signupStateOf({ signup_state: stale, signup_review: { state: "present" } }), stale)
    assert.deepStrictEqual(earnStateOf({ rewards, earn_state: stale }), stale)
  })
})
