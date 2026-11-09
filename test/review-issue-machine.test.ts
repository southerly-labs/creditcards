import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { IssueAction, IssueEvent, IssueState, planIssue, stepIssue } from "../src/machine/reviewIssue.ts"

const observed = (open: number, checked = true) => IssueEvent.cases.Observed.make({ open, checked })
const { Create, Edit, Close, Leave } = IssueAction.cases

describe("review issue machine", () => {
  it.effect("opens an issue for open items and closes it once none are left", () =>
    Effect.gen(function* () {
      const absent = IssueState.cases.Absent.make({})
      const open = IssueState.cases.Open.make({ number: 7 })

      assert.deepStrictEqual(yield* stepIssue(absent, observed(2)), IssueState.cases.Open.make({}))
      assert.deepStrictEqual(yield* stepIssue(absent, observed(0)), absent)
      assert.deepStrictEqual(yield* stepIssue(open, observed(1)), open)
      assert.deepStrictEqual(yield* stepIssue(open, observed(0)), absent)
    })
  )

  it.effect("plans the gh action from the open issue number", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* planIssue(undefined, observed(3)), Create.make({}))
      assert.deepStrictEqual(yield* planIssue(undefined, observed(0)), Leave.make({}))
      assert.deepStrictEqual(yield* planIssue(12, observed(3)), Edit.make({ number: 12 }))
      assert.deepStrictEqual(yield* planIssue(12, observed(0)), Close.make({ number: 12 }))
    })
  )

  it.effect("keeps the issue open when the items could not be checked", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* planIssue(12, observed(0, false)), Edit.make({ number: 12 }))
      assert.deepStrictEqual(yield* planIssue(undefined, observed(0, false)), Create.make({}))
    })
  )
})
