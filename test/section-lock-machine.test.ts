import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { LockEvent, LockState, lockStateOf, stepLock } from "../src/machine/sectionLock.ts"

const reviewed = "2026-08-01T00:00:00Z"
const fresh = LockState.cases.Fresh.make({ reviewed_at: reviewed })

describe("section lock machine", () => {
  it.effect("a correction locks a section as fresh, from any state", () =>
    Effect.gen(function* () {
      const correct = LockEvent.cases.Correct.make({ reviewed_at: reviewed })

      for (const state of [LockState.cases.Unlocked.make({}), LockState.cases.Undated.make({}), fresh])
        assert.deepStrictEqual(yield* stepLock(state, correct), fresh)
    })
  )

  it.effect("a fresh lock goes stale 90 days after its review; stale and undated locks stay as they are", () =>
    Effect.gen(function* () {
      const aged = (now: string) => LockEvent.cases.Aged.make({ now })

      assert.deepStrictEqual(yield* stepLock(fresh, aged("2026-10-29T23:59:59Z")), fresh)
      assert.deepStrictEqual(
        yield* stepLock(fresh, aged("2026-10-30T00:00:00Z")),
        LockState.cases.Stale.make({ reviewed_at: reviewed })
      )
      assert.deepStrictEqual(
        yield* stepLock(LockState.cases.Undated.make({}), aged("2027-01-01T00:00:00Z")),
        LockState.cases.Undated.make({})
      )
    })
  )

  it.effect("unlocking releases any lock; an unlocked path ignores unlock and ageing", () =>
    Effect.gen(function* () {
      const unlocked = LockState.cases.Unlocked.make({})

      assert.deepStrictEqual(yield* stepLock(fresh, LockEvent.cases.Unlock.make({})), unlocked)
      assert.deepStrictEqual(yield* stepLock(unlocked, LockEvent.cases.Unlock.make({})), unlocked)
      assert.deepStrictEqual(yield* stepLock(unlocked, LockEvent.cases.Aged.make({ now: reviewed })), unlocked)
    })
  )

  it("reads a lock from the card's locked paths and its section review", () => {
    const card = {
      locked: ["fees.late_payment", "network"],
      provenance: { sections: { fees: { reviewed_at: reviewed } } }
    }

    assert.deepStrictEqual(lockStateOf(card, "fees.late_payment"), fresh)
    assert.deepStrictEqual(lockStateOf(card, "network"), LockState.cases.Undated.make({}))
    assert.deepStrictEqual(lockStateOf(card, "rates.purchase"), LockState.cases.Unlocked.make({}))
  })
})
