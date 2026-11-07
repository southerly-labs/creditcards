import { Machine } from "@typeonce/effect-machine"
import { Array as EffectArray, Effect, Match, Option, Schema } from "effect"
import { encodedSnapshot } from "../../src/machine/snapshot.ts"

export const DialogName = Schema.Literals(["sheet", "compare", "values"])

export type DialogName = typeof DialogName.Type

export const DialogState = Schema.TaggedUnion({
  Browsing: {},
  Sheet: { card: Schema.String },
  Comparing: {},
  Values: {}
})

export type DialogState = typeof DialogState.Type

export const DialogEvent = Schema.TaggedUnion({
  OpenCard: { card: Schema.String },
  OpenCompare: {},
  OpenValues: {},
  Closed: { dialog: DialogName },
  TrayEmptied: {}
})

export type DialogEvent = typeof DialogEvent.Type

export const DialogStates = Machine.state({
  states: {
    Browsing: DialogState.cases.Browsing,
    Sheet: DialogState.cases.Sheet,
    Comparing: DialogState.cases.Comparing,
    Values: DialogState.cases.Values
  }
})

const openCard = {
  target: "Sheet",
  data: ({ event }: { readonly event: { readonly card: string } }) => ({ card: event.card })
} as const

export const DialogMachine = Machine.make({
  id: "FinderDialogs",
  root: DialogStates,
  events: Machine.eventsFromSchemas(DialogEvent),
  branches: {
    closed: { browse: { target: "Browsing" }, ignore: { none: true } }
  }
}).handle({
  initial: { target: "Browsing" },
  states: {
    Browsing: {
      on: { OpenCard: openCard, OpenCompare: { target: "Comparing" }, OpenValues: { target: "Values" } }
    },
    Sheet: {
      on: {
        OpenCard: openCard,
        Closed: {
          branches: "closed",
          resolve: ({ event, select }) => (event.dialog === "sheet" ? select.browse({ data: {} }) : select.ignore())
        }
      }
    },
    Comparing: {
      on: {
        OpenCard: openCard,
        TrayEmptied: { target: "Browsing" },
        Closed: {
          branches: "closed",
          resolve: ({ event, select }) => (event.dialog === "compare" ? select.browse({ data: {} }) : select.ignore())
        }
      }
    },
    Values: {
      on: {
        Closed: {
          branches: "closed",
          resolve: ({ event, select }) => (event.dialog === "values" ? select.browse({ data: {} }) : select.ignore())
        }
      }
    }
  }
})

export const TrayState = Schema.TaggedUnion({
  Empty: {},
  Picking: { ids: Schema.Array(Schema.String) },
  Ready: { ids: Schema.Array(Schema.String) }
})

export type TrayState = typeof TrayState.Type

export const TrayEvent = Schema.TaggedUnion({
  Toggle: { id: Schema.String, limit: Schema.Int },
  Clear: {}
})

export type TrayEvent = typeof TrayEvent.Type

export const TrayStates = Machine.state({
  states: { Empty: TrayState.cases.Empty, Picking: TrayState.cases.Picking, Ready: TrayState.cases.Ready }
})

export const trayIds = (tray: TrayState): ReadonlyArray<string> => (TrayState.guards.Empty(tray) ? [] : tray.ids)

const toggled = (ids: ReadonlyArray<string>, id: string, limit: number): ReadonlyArray<string> =>
  ids.includes(id)
    ? EffectArray.filter(ids, (x) => x !== id)
    : ids.length < limit
      ? [...ids, id]
      : [...ids.slice(1), id]

export const TrayMachine = Machine.make({
  id: "CompareTray",
  root: TrayStates,
  events: Machine.eventsFromSchemas(TrayEvent),
  branches: {
    toggle: { empty: { target: "Empty" }, picking: { target: "Picking" }, ready: { target: "Ready" } }
  }
}).handle({
  initial: { target: "Empty" },
  states: {
    Empty: {
      on: {
        Toggle: { target: "Picking", data: ({ event }) => ({ ids: [event.id] }) }
      }
    },
    Picking: {
      on: {
        Clear: { target: "Empty" },
        Toggle: {
          branches: "toggle",
          resolve: ({ state, event, select }) => {
            const ids = toggled(state.ids, event.id, event.limit)

            return Match.value(ids.length).pipe(
              Match.when(0, () => select.empty({ data: {} })),
              Match.when(1, () => select.picking({ data: { ids } })),
              Match.orElse(() => select.ready({ data: { ids } }))
            )
          }
        }
      }
    },
    Ready: {
      on: {
        Clear: { target: "Empty" },
        Toggle: {
          branches: "toggle",
          resolve: ({ state, event, select }) => {
            const ids = toggled(state.ids, event.id, event.limit)

            return ids.length === 1 ? select.picking({ data: { ids } }) : select.ready({ data: { ids } })
          }
        }
      }
    }
  }
})

export const trayOf = (ids: ReadonlyArray<string>): TrayState =>
  Match.value(ids.length).pipe(
    Match.when(0, (): TrayState => TrayState.cases.Empty.make({})),
    Match.when(1, (): TrayState => TrayState.cases.Picking.make({ ids })),
    Match.orElse((): TrayState => TrayState.cases.Ready.make({ ids }))
  )

export class UiSnapshotError extends Schema.TaggedError<UiSnapshotError, { readonly brand: unique symbol }>()(
  "UiSnapshotError",
  { message: Schema.String }
) {}

export const stepDialog = Effect.fn("stepDialog")(function* (state: DialogState, event: DialogEvent) {
  const snapshot = yield* Machine.decodeSnapshot(DialogMachine, encodedSnapshot([{ path: state._tag, value: state }]))

  const { next } = yield* Machine.plan(DialogMachine, snapshot, event)

  const read = Option.firstSomeOf<DialogState>([
    DialogStates.get(next, "Browsing"),
    DialogStates.get(next, "Sheet"),
    DialogStates.get(next, "Comparing"),
    DialogStates.get(next, "Values")
  ])

  if (Option.isNone(read)) return yield* UiSnapshotError.make({ message: "Dialog snapshot has no state" })

  return read.value
})

export const stepTray = Effect.fn("stepTray")(function* (state: TrayState, event: TrayEvent) {
  const snapshot = yield* Machine.decodeSnapshot(TrayMachine, encodedSnapshot([{ path: state._tag, value: state }]))

  const { next } = yield* Machine.plan(TrayMachine, snapshot, event)

  const read = Option.firstSomeOf<TrayState>([
    TrayStates.get(next, "Empty"),
    TrayStates.get(next, "Picking"),
    TrayStates.get(next, "Ready")
  ])

  if (Option.isNone(read)) return yield* UiSnapshotError.make({ message: "Tray snapshot has no state" })

  return read.value
})

export const openDialog = (state: DialogState): DialogName | undefined =>
  DialogState.guards.Sheet(state)
    ? "sheet"
    : DialogState.guards.Comparing(state)
      ? "compare"
      : DialogState.guards.Values(state)
        ? "values"
        : undefined
