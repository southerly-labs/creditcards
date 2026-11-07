import { Machine } from "@typeonce/effect-machine"
import { Effect, Option, Schema } from "effect"
import { encodedSnapshot } from "./snapshot.ts"

export const TaskState = Schema.TaggedUnion({
  Absent: {},
  Open: { since: Schema.String },
  Closed: {}
})

export type TaskState = typeof TaskState.Type

export const TaskEvent = Schema.TaggedUnion({
  Observed: { since: Schema.String },
  Unobserved: {}
})

export type TaskEvent = typeof TaskEvent.Type

export const TaskStates = Machine.state({
  states: { Absent: TaskState.cases.Absent, Open: TaskState.cases.Open, Closed: TaskState.cases.Closed }
})

const open = {
  target: "Open",
  data: ({ event }: { readonly event: { readonly since: string } }) => ({ since: event.since })
} as const

export const HumanTaskMachine = Machine.make({
  id: "HumanTask",
  root: TaskStates,
  events: Machine.eventsFromSchemas(TaskEvent)
}).handle({
  initial: { target: "Absent" },
  states: {
    Absent: { on: { Observed: open } },
    Open: { on: { Unobserved: { target: "Closed" } } },
    Closed: { on: { Observed: open } }
  }
})

export class TaskSnapshotError extends Schema.TaggedError<TaskSnapshotError, { readonly brand: unique symbol }>()(
  "TaskSnapshotError",
  { message: Schema.String }
) {}

export const stepTask = Effect.fn("stepTask")(function* (state: TaskState, event: TaskEvent) {
  const snapshot = yield* Machine.decodeSnapshot(
    HumanTaskMachine,
    encodedSnapshot([{ path: state._tag, value: state }])
  )

  const { next } = yield* Machine.plan(HumanTaskMachine, snapshot, event)

  const read = Option.firstSomeOf<TaskState>([
    TaskStates.get(next, "Absent"),
    TaskStates.get(next, "Open"),
    TaskStates.get(next, "Closed")
  ])

  if (Option.isNone(read)) return yield* TaskSnapshotError.make({ message: "Task snapshot has no state" })

  return read.value
})
