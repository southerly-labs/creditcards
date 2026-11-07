import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { needsReview, ReviewEvent, SourceReview, stepReview, unread } from "../src/machine/review.ts"

const { Read, Stamp } = ReviewEvent.cases
const { Parsed, Unreadable, Reviewed, Stale } = SourceReview.cases

describe("source review machine", () => {
  it.effect("the parser's reading of the text moves an unreviewed card between parsed, unreadable and unread", () =>
    Effect.gen(function* () {
      const parsed = yield* stepReview(unread, Read.make({ hash: "a", outcome: "parsed" }))
      assert.deepStrictEqual(parsed, Parsed.make({ hash: "a" }))

      const lost = yield* stepReview(parsed, Read.make({ hash: "b", outcome: "unreadable" }))
      assert.deepStrictEqual(lost, Unreadable.make({ hash: "b" }))
      assert.deepStrictEqual(
        yield* stepReview(lost, Read.make({ hash: "c", outcome: "parsed" })),
        Parsed.make({ hash: "c" })
      )
      assert.deepStrictEqual(yield* stepReview(parsed, Read.make({ hash: "d", outcome: "nothing" })), unread)
      assert.deepStrictEqual(yield* stepReview(unread, Read.make({ hash: "d", outcome: "nothing" })), unread)
    })
  )

  it.effect("a review holds until the text changes, then is stale until the text returns or it is stamped again", () =>
    Effect.gen(function* () {
      const review = Reviewed.make({ hash: "a", outcome: "present", on: "2026-11-01" })
      assert.deepStrictEqual(yield* stepReview(review, Read.make({ hash: "a", outcome: "unreadable" })), review)

      const stale = yield* stepReview(review, Read.make({ hash: "b", outcome: "parsed" }))
      assert.deepStrictEqual(stale, Stale.make({ hash: "a", outcome: "present", on: "2026-11-01" }))
      assert.deepStrictEqual(yield* stepReview(stale, Read.make({ hash: "c", outcome: "parsed" })), stale)
      assert.deepStrictEqual(yield* stepReview(stale, Read.make({ hash: "a", outcome: "parsed" })), review)

      const restamped = yield* stepReview(stale, Stamp.make({ hash: "c", outcome: "none", on: "2026-11-07" }))
      assert.deepStrictEqual(restamped, Reviewed.make({ hash: "c", outcome: "none", on: "2026-11-07" }))
    })
  )

  it.effect("a stamp records a review from any state", () =>
    Effect.gen(function* () {
      const stamp = Stamp.make({ hash: "h", outcome: "present", on: "2026-11-07" })
      const expected = Reviewed.make({ hash: "h", outcome: "present", on: "2026-11-07" })

      for (const state of [unread, Parsed.make({ hash: "a" }), Unreadable.make({ hash: "a" })])
        assert.deepStrictEqual(yield* stepReview(state, stamp), expected)
    })
  )

  it("needs a reviewer only when the parser cannot read the text or a review has gone stale", () => {
    assert.isTrue(needsReview(Unreadable.make({ hash: "a" })))
    assert.isTrue(needsReview(Stale.make({ hash: "a", outcome: "none" })))
    assert.isFalse(needsReview(unread))
    assert.isFalse(needsReview(Parsed.make({ hash: "a" })))
    assert.isFalse(needsReview(Reviewed.make({ hash: "a", outcome: "present" })))
  })
})
