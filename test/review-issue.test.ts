import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { HoldState } from "../src/machine/hold.ts"
import { IssueAction, planIssue } from "../src/machine/reviewIssue.ts"
import { heldIssueEvent, heldOpenCount, rewardsIssueEvent } from "../src/review/issue.ts"

const decision = { on: "2026-11-02", evidence: "checked" }
const hold = (state: HoldState) => ({ id: state._tag, card: "x/card", since: "2026-11-01", state })

describe("review issues", () => {
  it("counts whole held cards and pending holds, not decided ones", () => {
    assert.strictEqual(
      heldOpenCount({
        held: [{ card: "x/invalid" }],
        holds: [
          hold(HoldState.cases.AwaitingApproval.make({})),
          hold(HoldState.cases.AwaitingConfirmation.make({})),
          hold(HoldState.cases.Approved.make(decision)),
          hold(HoldState.cases.Rejected.make(decision))
        ]
      }),
      3
    )
    assert.strictEqual(heldOpenCount({}), 0)
  })

  it.effect("closes the held issue once nothing is held", () =>
    Effect.gen(function* () {
      const clear = heldIssueEvent({ holds: [hold(HoldState.cases.Approved.make(decision))] })

      assert.deepStrictEqual(yield* planIssue(4, clear), IssueAction.cases.Close.make({ number: 4 }))
    })
  )

  it.effect("keeps the rewards issue open while the page check failed", () =>
    Effect.gen(function* () {
      const queue = { report: {}, pages: [] }

      assert.deepStrictEqual(
        yield* planIssue(9, rewardsIssueEvent(queue, true)),
        IssueAction.cases.Close.make({ number: 9 })
      )
      assert.deepStrictEqual(
        yield* planIssue(9, rewardsIssueEvent(queue, false)),
        IssueAction.cases.Edit.make({ number: 9 })
      )
    })
  )
})
