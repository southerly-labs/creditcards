import { Machine } from "@typeonce/effect-machine"
import { Array as EffectArray, Effect, Match, Option, Schema } from "effect"
import { CalendarDate } from "../model/domain.ts"
import { encodedSnapshot } from "./snapshot.ts"

export const ReviewOutcome = Schema.Literals(["present", "none"])

export type ReviewOutcome = typeof ReviewOutcome.Type

const Review = { hash: Schema.String, outcome: ReviewOutcome, on: Schema.optionalKey(CalendarDate) }

export const SourceReview = Schema.TaggedUnion({
  Unread: {},
  Parsed: { hash: Schema.String },
  Unreadable: { hash: Schema.String },
  Reviewed: Review,
  Stale: Review
})

export type SourceReview = typeof SourceReview.Type

export const ReadOutcome = Schema.Literals(["parsed", "nothing", "unreadable"])

export type ReadOutcome = typeof ReadOutcome.Type

export const ReviewEvent = Schema.TaggedUnion({
  Read: { hash: Schema.String, outcome: ReadOutcome },
  Stamp: { hash: Schema.String, outcome: ReviewOutcome, on: CalendarDate }
})

export type ReviewEvent = typeof ReviewEvent.Type

export const ReviewStates = Machine.state({
  states: {
    Unread: SourceReview.cases.Unread,
    Parsed: SourceReview.cases.Parsed,
    Unreadable: SourceReview.cases.Unreadable,
    Reviewed: SourceReview.cases.Reviewed,
    Stale: SourceReview.cases.Stale
  }
})

export const ReviewEvents = Machine.eventsFromSchemas(ReviewEvent)

const stamped = ({
  event
}: {
  readonly event: { readonly hash: string; readonly outcome: ReviewOutcome; readonly on: string }
}) => ({
  hash: event.hash,
  outcome: event.outcome,
  on: event.on
})

const reviewed = (state: { readonly hash: string; readonly outcome: ReviewOutcome; readonly on?: string }) => ({
  hash: state.hash,
  outcome: state.outcome,
  ...(state.on === undefined ? {} : { on: state.on })
})

const stamp = { Stamp: { target: "Reviewed", data: stamped } } as const

export const ReviewMachine = Machine.make({
  id: "SourceReview",
  root: ReviewStates,
  events: ReviewEvents,
  branches: {
    read: {
      parsed: { target: "Parsed" },
      unreadable: { target: "Unreadable" },
      unread: { target: "Unread" },
      unchanged: { none: true }
    },
    reread: {
      stale: { target: "Stale" },
      current: { target: "Reviewed" },
      unchanged: { none: true }
    }
  }
}).handle({
  initial: { target: "Unread" },
  states: {
    Unread: {
      on: {
        ...stamp,
        Read: {
          branches: "read",
          resolve: ({ event, select }) =>
            Match.value(event.outcome).pipe(
              Match.when("parsed", () => select.parsed({ data: { hash: event.hash } })),
              Match.when("unreadable", () => select.unreadable({ data: { hash: event.hash } })),
              Match.when("nothing", () => select.unchanged()),
              Match.exhaustive
            )
        }
      }
    },
    Parsed: {
      on: {
        ...stamp,
        Read: {
          branches: "read",
          resolve: ({ event, select }) =>
            Match.value(event.outcome).pipe(
              Match.when("parsed", () => select.parsed({ data: { hash: event.hash } })),
              Match.when("unreadable", () => select.unreadable({ data: { hash: event.hash } })),
              Match.when("nothing", () => select.unread({ data: {} })),
              Match.exhaustive
            )
        }
      }
    },
    Unreadable: {
      on: {
        ...stamp,
        Read: {
          branches: "read",
          resolve: ({ event, select }) =>
            Match.value(event.outcome).pipe(
              Match.when("parsed", () => select.parsed({ data: { hash: event.hash } })),
              Match.when("unreadable", () => select.unreadable({ data: { hash: event.hash } })),
              Match.when("nothing", () => select.unread({ data: {} })),
              Match.exhaustive
            )
        }
      }
    },
    Reviewed: {
      on: {
        ...stamp,
        Read: {
          branches: "reread",
          resolve: ({ state, event, select }) =>
            event.hash === state.hash ? select.unchanged() : select.stale({ data: reviewed(state) })
        }
      }
    },
    Stale: {
      on: {
        ...stamp,
        Read: {
          branches: "reread",
          resolve: ({ state, event, select }) =>
            event.hash === state.hash ? select.current({ data: reviewed(state) }) : select.unchanged()
        }
      }
    }
  }
})

type ReviewSnapshot = Machine.Snapshot<typeof ReviewStates>

export class ReviewSnapshotError extends Schema.TaggedError<ReviewSnapshotError, { readonly brand: unique symbol }>()(
  "ReviewSnapshotError",
  { message: Schema.String }
) {}

const readState = (snapshot: ReviewSnapshot): Option.Option<SourceReview> =>
  Option.firstSomeOf<SourceReview>(
    EffectArray.map(["Unread", "Parsed", "Unreadable", "Reviewed", "Stale"] as const, (path) =>
      ReviewStates.get(snapshot, path)
    )
  )

export const stepReview = Effect.fn("stepReview")(function* (state: SourceReview, event: ReviewEvent) {
  const snapshot = yield* Machine.decodeSnapshot(ReviewMachine, encodedSnapshot([{ path: state._tag, value: state }]))
  const planned = yield* Machine.plan(ReviewMachine, snapshot, event)
  const next = readState(planned.next)

  if (Option.isNone(next)) return yield* ReviewSnapshotError.make({ message: "Review snapshot has no state" })

  return next.value
})

export const unread: SourceReview = SourceReview.cases.Unread.make({})

export const needsReview = (state: SourceReview): boolean =>
  SourceReview.guards.Unreadable(state) || SourceReview.guards.Stale(state)
