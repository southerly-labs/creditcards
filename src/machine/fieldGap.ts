import { Machine } from "@typeonce/effect-machine"
import { Effect, Option, Schema } from "effect"
import { FieldGap } from "../model/schema.ts"
import { encodedSnapshot } from "./snapshot.ts"

export const GapState = Schema.TaggedUnion({
  Known: {},
  Explained: { gap: FieldGap },
  Unexplained: {}
})

export type GapState = typeof GapState.Type

export const GapEvent = Schema.TaggedUnion({
  Observed: { present: Schema.Boolean },
  Explain: { gap: FieldGap }
})

export type GapEvent = typeof GapEvent.Type

export const GapStates = Machine.state({
  states: { Known: GapState.cases.Known, Explained: GapState.cases.Explained, Unexplained: GapState.cases.Unexplained }
})

export const FieldGapMachine = Machine.make({
  id: "FieldGap",
  root: GapStates,
  events: Machine.eventsFromSchemas(GapEvent),
  branches: {
    filled: { known: { target: "Known" }, empty: { none: true } },
    emptied: { unexplained: { target: "Unexplained" }, present: { none: true } }
  }
}).handle({
  initial: { target: "Unexplained" },
  states: {
    Known: {
      on: {
        Observed: {
          branches: "emptied",
          resolve: ({ event, select }) => (event.present ? select.present() : select.unexplained({ data: {} }))
        }
      }
    },
    Explained: {
      on: {
        Observed: {
          branches: "filled",
          resolve: ({ event, select }) => (event.present ? select.known({ data: {} }) : select.empty())
        },
        Explain: { target: "Explained", data: ({ event }) => ({ gap: event.gap }) }
      }
    },
    Unexplained: {
      on: {
        Observed: {
          branches: "filled",
          resolve: ({ event, select }) => (event.present ? select.known({ data: {} }) : select.empty())
        },
        Explain: { target: "Explained", data: ({ event }) => ({ gap: event.gap }) }
      }
    }
  }
})

export class GapSnapshotError extends Schema.TaggedError<GapSnapshotError, { readonly brand: unique symbol }>()(
  "GapSnapshotError",
  { message: Schema.String }
) {}

export const stepGap = Effect.fn("stepGap")(function* (state: GapState, event: GapEvent) {
  const snapshot = yield* Machine.decodeSnapshot(FieldGapMachine, encodedSnapshot([{ path: state._tag, value: state }]))
  const { next } = yield* Machine.plan(FieldGapMachine, snapshot, event)

  const read = Option.firstSomeOf<GapState>([
    GapStates.get(next, "Known"),
    GapStates.get(next, "Explained"),
    GapStates.get(next, "Unexplained")
  ])

  if (Option.isNone(read)) return yield* GapSnapshotError.make({ message: "Gap snapshot has no state" })

  return read.value
})

export const observeGaps = Effect.fn("observeGaps")(function* (
  gaps: ReadonlyArray<FieldGap>,
  present: (field: FieldGap["field"]) => boolean
) {
  const kept: Array<FieldGap> = []

  for (const gap of gaps) {
    const state = yield* stepGap(
      GapState.cases.Explained.make({ gap }),
      GapEvent.cases.Observed.make({ present: present(gap.field) })
    )

    if (GapState.guards.Explained(state)) kept.push(state.gap)
  }

  return kept
})
