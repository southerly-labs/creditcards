import { assert, describe, it } from "@effect/vitest"
import { SourceReview, unread } from "../src/machine/review.ts"
import { earnStateOf, publicRewards, publicSignupReview, signupStateOf } from "../src/rewards/state.ts"

describe("review state", () => {
  it("is Unread until the card records one", () => {
    const stale = SourceReview.cases.Stale.make({ hash: "h", outcome: "present" })

    assert.deepStrictEqual(earnStateOf({}), unread)
    assert.deepStrictEqual(signupStateOf(undefined), unread)
    assert.deepStrictEqual(earnStateOf({ earn_state: stale }), stale)
    assert.deepStrictEqual(signupStateOf({ signup_state: stale }), stale)
  })

  it("publishes the legacy earn fields the API has always carried", () => {
    const rewards = { program: "qantas", earn: [{ rate: 1 }] }

    assert.deepStrictEqual(publicRewards(rewards, unread), rewards)
    assert.deepStrictEqual(publicRewards(rewards, SourceReview.cases.Parsed.make({ hash: "h" })), {
      ...rewards,
      earn_source: "parser",
      earn_text_hash: "h",
      earn_review: { state: "present" }
    })
    assert.deepStrictEqual(
      publicRewards(rewards, SourceReview.cases.Stale.make({ hash: "h", outcome: "none", on: "2026-11-01" })),
      {
        ...rewards,
        earn_source: "manual",
        earn_text_hash: "h",
        earn_review: { state: "none", reviewed_at: "2026-11-01" }
      }
    )
  })

  it("publishes signup_review the same way", () => {
    assert.isUndefined(publicSignupReview(unread))
    assert.deepStrictEqual(publicSignupReview(SourceReview.cases.Unreadable.make({ hash: "h" })), { state: "unknown" })
    assert.deepStrictEqual(publicSignupReview(SourceReview.cases.Reviewed.make({ hash: "h", outcome: "present" })), {
      state: "present",
      source: "manual",
      text_hash: "h"
    })
  })
})
