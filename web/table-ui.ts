import { Machine } from "@typeonce/effect-machine"
import { Effect, Option, Schema } from "effect"
import { encodedSnapshot } from "../src/machine/snapshot.ts"

export const SortState = Schema.TaggedUnion({
  Ascending: { column: Schema.Int },
  Descending: { column: Schema.Int }
})

export type SortState = typeof SortState.Type

export const SortEvent = Schema.TaggedUnion({ HeaderClicked: { column: Schema.Int } })

export type SortEvent = typeof SortEvent.Type

export const SortStates = Machine.state({
  states: { Ascending: SortState.cases.Ascending, Descending: SortState.cases.Descending }
})

export const SortMachine = Machine.make({
  id: "TableSort",
  root: SortStates,
  events: Machine.eventsFromSchemas(SortEvent),
  branches: {
    clicked: { ascending: { target: "Ascending" }, descending: { target: "Descending" } }
  }
}).handle({
  initial: { target: "Ascending", data: { column: 0 } },
  states: {
    Ascending: {
      on: {
        HeaderClicked: {
          branches: "clicked",
          resolve: ({ state, event, select }) =>
            event.column === state.column
              ? select.descending({ data: { column: event.column } })
              : select.ascending({ data: { column: event.column } })
        }
      }
    },
    Descending: {
      on: {
        HeaderClicked: {
          branches: "clicked",
          resolve: ({ event, select }) => select.ascending({ data: { column: event.column } })
        }
      }
    }
  }
})

export const Visibility = Schema.TaggedUnion({ Default: {}, Shown: {}, Hidden: {} })

export type Visibility = typeof Visibility.Type

export const VisibilityEvent = Schema.TaggedUnion({
  Picked: { checked: Schema.Boolean, shownByDefault: Schema.Boolean },
  Reset: {}
})

export type VisibilityEvent = typeof VisibilityEvent.Type

export const VisibilityStates = Machine.state({
  states: { Default: Visibility.cases.Default, Shown: Visibility.cases.Shown, Hidden: Visibility.cases.Hidden }
})

export const VisibilityMachine = Machine.make({
  id: "ColumnVisibility",
  root: VisibilityStates,
  events: Machine.eventsFromSchemas(VisibilityEvent),
  branches: {
    picked: { asDefault: { target: "Default" }, shown: { target: "Shown" }, hidden: { target: "Hidden" } }
  }
}).handle({
  initial: { target: "Default" },
  states: {
    Default: {
      on: {
        Picked: {
          branches: "picked",
          resolve: ({ event, select }) =>
            event.checked === event.shownByDefault
              ? select.asDefault({ data: {} })
              : event.checked
                ? select.shown({ data: {} })
                : select.hidden({ data: {} })
        }
      }
    },
    Shown: {
      on: {
        Reset: { target: "Default" },
        Picked: {
          branches: "picked",
          resolve: ({ event, select }) =>
            event.checked === event.shownByDefault
              ? select.asDefault({ data: {} })
              : event.checked
                ? select.shown({ data: {} })
                : select.hidden({ data: {} })
        }
      }
    },
    Hidden: {
      on: {
        Reset: { target: "Default" },
        Picked: {
          branches: "picked",
          resolve: ({ event, select }) =>
            event.checked === event.shownByDefault
              ? select.asDefault({ data: {} })
              : event.checked
                ? select.shown({ data: {} })
                : select.hidden({ data: {} })
        }
      }
    }
  }
})

export class TableUiError extends Schema.TaggedError<TableUiError, { readonly brand: unique symbol }>()(
  "TableUiError",
  { message: Schema.String }
) {}

export const stepSort = Effect.fn("stepSort")(function* (state: SortState, event: SortEvent) {
  const snapshot = yield* Machine.decodeSnapshot(SortMachine, encodedSnapshot([{ path: state._tag, value: state }]))

  const { next } = yield* Machine.plan(SortMachine, snapshot, event)
  const read = Option.firstSomeOf<SortState>([SortStates.get(next, "Ascending"), SortStates.get(next, "Descending")])

  if (Option.isNone(read)) return yield* TableUiError.make({ message: "Sort snapshot has no state" })

  return read.value
})

export const stepVisibility = Effect.fn("stepVisibility")(function* (state: Visibility, event: VisibilityEvent) {
  const snapshot = yield* Machine.decodeSnapshot(
    VisibilityMachine,
    encodedSnapshot([{ path: state._tag, value: state }])
  )

  const { next } = yield* Machine.plan(VisibilityMachine, snapshot, event)

  const read = Option.firstSomeOf<Visibility>([
    VisibilityStates.get(next, "Default"),
    VisibilityStates.get(next, "Shown"),
    VisibilityStates.get(next, "Hidden")
  ])

  if (Option.isNone(read)) return yield* TableUiError.make({ message: "Visibility snapshot has no state" })

  return read.value
})

export const visibilityOf = (choice: boolean | undefined): Visibility =>
  choice === undefined
    ? Visibility.cases.Default.make({})
    : choice
      ? Visibility.cases.Shown.make({})
      : Visibility.cases.Hidden.make({})

export const choiceOf = (visibility: Visibility): boolean | undefined =>
  Visibility.guards.Default(visibility) ? undefined : Visibility.guards.Shown(visibility)
