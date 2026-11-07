import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { HoldEvent, HoldOutcome, HoldState, pendingState, stepHold } from "../src/machine/hold.ts"

const { Proposed, Approve, Reject, Withdrawn } = HoldEvent.cases
const { AwaitingApproval, AwaitingConfirmation, Approved, Rejected } = HoldState.cases
const held = (state: HoldState) => HoldOutcome.cases.Held.make({ state })
const applied = HoldOutcome.cases.Applied.make({})
const withdrawn = HoldOutcome.cases.Withdrawn.make({})

const proposed = (kind: "approve" | "confirm", today: string) => Proposed.make({ kind, today, since: "2026-11-02" })
const approval = { on: "2026-11-02", evidence: "CDR says $1,000" }

describe("hold machine", () => {
  it.effect("a change that needs approval waits however often CDR proposes it", () =>
    Effect.gen(function* () {
      const waiting = AwaitingApproval.make({})

      assert.deepStrictEqual(yield* stepHold(waiting, proposed("approve", "2026-11-02")), held(waiting))
      assert.deepStrictEqual(yield* stepHold(waiting, proposed("approve", "2026-11-09")), held(waiting))
    })
  )

  it.effect("a change waiting to confirm applies once CDR still proposes it on a later day", () =>
    Effect.gen(function* () {
      const waiting = AwaitingConfirmation.make({})

      assert.deepStrictEqual(yield* stepHold(waiting, proposed("confirm", "2026-11-02")), held(waiting))
      assert.deepStrictEqual(yield* stepHold(waiting, proposed("confirm", "2026-11-03")), applied)
    })
  )

  it.effect("a pending hold follows the kind CDR history gives it today", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* stepHold(AwaitingApproval.make({}), proposed("confirm", "2026-11-02")),
        held(AwaitingConfirmation.make({}))
      )
      assert.deepStrictEqual(yield* stepHold(AwaitingApproval.make({}), proposed("confirm", "2026-11-03")), applied)
      assert.deepStrictEqual(
        yield* stepHold(AwaitingConfirmation.make({}), proposed("approve", "2026-11-03")),
        held(AwaitingApproval.make({}))
      )
    })
  )

  it.effect("an approved hold applies the next time CDR proposes it; a rejected one stays", () =>
    Effect.gen(function* () {
      const approved = yield* stepHold(AwaitingApproval.make({}), Approve.make(approval))
      assert.deepStrictEqual(approved, held(Approved.make(approval)))
      assert.deepStrictEqual(yield* stepHold(Approved.make(approval), proposed("approve", "2026-11-03")), applied)

      const misread = { on: "2026-11-02", evidence: "parser misread" }
      const rejected = Rejected.make(misread)
      assert.deepStrictEqual(yield* stepHold(AwaitingConfirmation.make({}), Reject.make(misread)), held(rejected))
      assert.deepStrictEqual(yield* stepHold(rejected, proposed("confirm", "2026-11-09")), held(rejected))
    })
  )

  it.effect("a decision can be changed, and any open hold is withdrawn when CDR stops proposing it", () =>
    Effect.gen(function* () {
      const rejected = { on: "2026-11-03", evidence: "on reflection, a typo" }

      assert.deepStrictEqual(
        yield* stepHold(Approved.make(approval), Reject.make(rejected)),
        held(Rejected.make(rejected))
      )
      assert.deepStrictEqual(
        yield* stepHold(Rejected.make(rejected), Approve.make(approval)),
        held(Approved.make(approval))
      )

      for (const state of [
        AwaitingApproval.make({}),
        AwaitingConfirmation.make({}),
        Approved.make(approval),
        Rejected.make(rejected)
      ])
        assert.deepStrictEqual(yield* stepHold(state, Withdrawn.make({})), withdrawn)
    })
  )

  it("starts a new hold in the pending state for its kind", () => {
    assert.deepStrictEqual(pendingState("approve"), AwaitingApproval.make({}))
    assert.deepStrictEqual(pendingState("confirm"), AwaitingConfirmation.make({}))
  })
})
