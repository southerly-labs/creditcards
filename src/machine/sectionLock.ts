import { Machine } from "@typeonce/effect-machine"
import { Array as EffectArray, DateTime, Effect, Option, Schema, String as EffectString } from "effect"
import { dual } from "effect/Function"
import { encodedSnapshot } from "./snapshot.ts"

export const LOCK_REVIEW_DAYS = 90

export const LockState = Schema.TaggedUnion({
  Unlocked: {},
  Fresh: { reviewed_at: Schema.String },
  Stale: { reviewed_at: Schema.String },
  Undated: {}
})

export type LockState = typeof LockState.Type

export const LockEvent = Schema.TaggedUnion({
  Correct: { reviewed_at: Schema.String },
  Unlock: {},
  Aged: { now: Schema.String }
})

export type LockEvent = typeof LockEvent.Type

export const LockStates = Machine.state({
  states: {
    Unlocked: LockState.cases.Unlocked,
    Locked: {
      states: { Fresh: LockState.cases.Fresh, Stale: LockState.cases.Stale, Undated: LockState.cases.Undated }
    }
  }
})

const ageInDays = (reviewedAt: string, now: string) =>
  Option.match(Option.all([DateTime.make(reviewedAt), DateTime.make(now)]), {
    onNone: () => Number.POSITIVE_INFINITY,
    onSome: ([reviewed, at]) => (DateTime.toEpochMillis(at) - DateTime.toEpochMillis(reviewed)) / 86_400_000
  })

export const SectionLockMachine = Machine.make({
  id: "SectionLock",
  root: LockStates,
  events: Machine.eventsFromSchemas(LockEvent),
  branches: {
    aged: { stale: { target: "Locked.Stale" }, fresh: { none: true } }
  }
}).handle({
  initial: { target: "Unlocked" },
  states: {
    Unlocked: {
      on: { Correct: { target: "Locked.Fresh", data: ({ event }) => ({ reviewed_at: event.reviewed_at }) } }
    },
    Locked: {
      initial: { target: "Locked.Undated" },
      on: {
        Correct: { target: "Locked.Fresh", data: ({ event }) => ({ reviewed_at: event.reviewed_at }) },
        Unlock: { target: "Unlocked" }
      },
      states: {
        Fresh: {
          on: {
            Aged: {
              branches: "aged",
              resolve: ({ state, event, select }) =>
                ageInDays(state.reviewed_at, event.now) >= LOCK_REVIEW_DAYS
                  ? select.stale({ data: { reviewed_at: state.reviewed_at } })
                  : select.fresh()
            }
          }
        },
        Stale: {},
        Undated: {}
      }
    }
  }
})

const pathsOf = LockState.match({
  Unlocked: () => ["Unlocked"],
  Fresh: () => ["Locked", "Locked.Fresh"],
  Stale: () => ["Locked", "Locked.Stale"],
  Undated: () => ["Locked", "Locked.Undated"]
})

export class LockSnapshotError extends Schema.TaggedError<LockSnapshotError, { readonly brand: unique symbol }>()(
  "LockSnapshotError",
  { message: Schema.String }
) {}

export const stepLock = Effect.fn("stepLock")(function* (state: LockState, event: LockEvent) {
  const paths = pathsOf(state)

  const snapshot = yield* Machine.decodeSnapshot(
    SectionLockMachine,
    encodedSnapshot(EffectArray.map(paths, (path, i) => (i === paths.length - 1 ? { path, value: state } : { path })))
  )

  const { next } = yield* Machine.plan(SectionLockMachine, snapshot, event)

  const read = Option.firstSomeOf<LockState>([
    LockStates.get(next, "Unlocked"),
    LockStates.get(next, "Locked.Fresh"),
    LockStates.get(next, "Locked.Stale"),
    LockStates.get(next, "Locked.Undated")
  ])

  if (Option.isNone(read)) return yield* LockSnapshotError.make({ message: "Lock snapshot has no state" })

  return read.value
})

interface LockedCard {
  readonly locked?: ReadonlyArray<string>
  readonly provenance?: { readonly sections?: Readonly<Record<string, { readonly reviewed_at: string }>> }
}

export const lockSection = (path: string): string => EffectString.split(path, ".")[0]

function lockStateOfImpl(card: LockedCard, path: string): LockState {
  if (!(card.locked ?? []).includes(path)) return LockState.cases.Unlocked.make({})
  const review = card.provenance?.sections?.[lockSection(path)]

  return review === undefined
    ? LockState.cases.Undated.make({})
    : LockState.cases.Fresh.make({ reviewed_at: review.reviewed_at })
}

export const lockStateOf = dual<
  (path: string) => (card: LockedCard) => LockState,
  (card: LockedCard, path: string) => LockState
>(2, lockStateOfImpl)
