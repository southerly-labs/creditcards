import { Machine } from "@typeonce/effect-machine"
import { Effect, Option, Schema } from "effect"
import { dual } from "effect/Function"
import { encodedSnapshot } from "./snapshot.ts"

export const IssueState = Schema.TaggedUnion({
  Absent: {},
  Open: { number: Schema.optionalKey(Schema.Int) }
})

export type IssueState = typeof IssueState.Type

export const IssueEvent = Schema.TaggedUnion({
  Observed: { open: Schema.Int, checked: Schema.Boolean }
})

export type IssueEvent = typeof IssueEvent.Type

export const IssueStates = Machine.state({
  states: { Absent: IssueState.cases.Absent, Open: IssueState.cases.Open }
})

const needsReview = (event: IssueEvent) => event.open > 0 || !event.checked

export const ReviewIssueMachine = Machine.make({
  id: "ReviewIssue",
  root: IssueStates,
  events: Machine.eventsFromSchemas(IssueEvent),
  branches: {
    absent: { open: { target: "Open" }, quiet: { none: true } },
    open: { keep: { none: true }, close: { target: "Absent" } }
  }
}).handle({
  initial: { target: "Absent" },
  states: {
    Absent: {
      on: {
        Observed: {
          branches: "absent",
          resolve: ({ event, select }) => (needsReview(event) ? select.open({ data: {} }) : select.quiet())
        }
      }
    },
    Open: {
      on: {
        Observed: {
          branches: "open",
          resolve: ({ event, select }) => (needsReview(event) ? select.keep() : select.close({ data: {} }))
        }
      }
    }
  }
})

export class IssueSnapshotError extends Schema.TaggedError<IssueSnapshotError, { readonly brand: unique symbol }>()(
  "IssueSnapshotError",
  { message: Schema.String }
) {}

export const stepIssue = Effect.fn("stepIssue")(function* (state: IssueState, event: IssueEvent) {
  const snapshot = yield* Machine.decodeSnapshot(
    ReviewIssueMachine,
    encodedSnapshot([{ path: state._tag, value: state }])
  )

  const { next } = yield* Machine.plan(ReviewIssueMachine, snapshot, event)
  const read = Option.firstSomeOf<IssueState>([IssueStates.get(next, "Absent"), IssueStates.get(next, "Open")])

  if (Option.isNone(read)) return yield* IssueSnapshotError.make({ message: "Issue snapshot has no state" })

  return read.value
})

export const IssueAction = Schema.TaggedUnion({
  Create: {},
  Edit: { number: Schema.Int },
  Close: { number: Schema.Int },
  Leave: {}
})

export type IssueAction = typeof IssueAction.Type

const actionImpl = (before: IssueState, after: IssueState): IssueAction => {
  if (IssueState.guards.Absent(after))
    return IssueState.guards.Open(before) && before.number !== undefined
      ? IssueAction.cases.Close.make({ number: before.number })
      : IssueAction.cases.Leave.make({})

  return IssueState.guards.Open(before) && before.number !== undefined
    ? IssueAction.cases.Edit.make({ number: before.number })
    : IssueAction.cases.Create.make({})
}

export const issueAction = dual<
  (after: IssueState) => (before: IssueState) => IssueAction,
  (before: IssueState, after: IssueState) => IssueAction
>(2, actionImpl)

export const issueStateOf = (number: number | undefined): IssueState =>
  number === undefined ? IssueState.cases.Absent.make({}) : IssueState.cases.Open.make({ number })

export const planIssue = Effect.fn("planIssue")(function* (number: number | undefined, event: IssueEvent) {
  const before = issueStateOf(number)

  return issueAction(before, yield* stepIssue(before, event))
})
