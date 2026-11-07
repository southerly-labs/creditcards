import { Machine } from "@typeonce/effect-machine"
import { Effect, Option, Schema } from "effect"
import { encodedSnapshot } from "./snapshot.ts"

export const FetchState = Schema.TaggedUnion({
  FirstTry: {},
  Retrying: { error: Schema.String },
  Done: {},
  GaveUp: { error: Schema.String }
})

export type FetchState = typeof FetchState.Type

export const FetchEvent = Schema.TaggedUnion({
  Fetched: { listError: Schema.optionalKey(Schema.String) }
})

export type FetchEvent = typeof FetchEvent.Type

export const FetchStates = Machine.state({
  states: {
    FirstTry: FetchState.cases.FirstTry,
    Retrying: FetchState.cases.Retrying,
    Done: { schema: FetchState.cases.Done, type: "final" },
    GaveUp: { schema: FetchState.cases.GaveUp, type: "final" }
  }
})

export const isRetryable = (listError: string): boolean => !/HTTP 4\d\d/u.test(listError)

export const BrandFetchMachine = Machine.make({
  id: "BrandFetch",
  root: FetchStates,
  events: Machine.eventsFromSchemas(FetchEvent),
  branches: {
    first: { done: { target: "Done" }, retry: { target: "Retrying" }, giveUp: { target: "GaveUp" } },
    retried: { done: { target: "Done" }, giveUp: { target: "GaveUp" } }
  }
}).handle({
  initial: { target: "FirstTry" },
  states: {
    FirstTry: {
      on: {
        Fetched: {
          branches: "first",
          resolve: ({ event, select }) =>
            event.listError === undefined
              ? select.done({ data: {} })
              : isRetryable(event.listError)
                ? select.retry({ data: { error: event.listError } })
                : select.giveUp({ data: { error: event.listError } })
        }
      }
    },
    Retrying: {
      on: {
        Fetched: {
          branches: "retried",
          resolve: ({ event, select }) =>
            event.listError === undefined
              ? select.done({ data: {} })
              : select.giveUp({ data: { error: event.listError } })
        }
      }
    },
    Done: {},
    GaveUp: {}
  }
})

export class FetchSnapshotError extends Schema.TaggedError<FetchSnapshotError, { readonly brand: unique symbol }>()(
  "FetchSnapshotError",
  { message: Schema.String }
) {}

export const stepFetch = Effect.fn("stepFetch")(function* (state: FetchState, event: FetchEvent) {
  const snapshot = yield* Machine.decodeSnapshot(
    BrandFetchMachine,
    encodedSnapshot([{ path: state._tag, value: state }])
  )

  const { next } = yield* Machine.plan(BrandFetchMachine, snapshot, event)

  const read = Option.firstSomeOf<FetchState>([
    FetchStates.get(next, "FirstTry"),
    FetchStates.get(next, "Retrying"),
    FetchStates.get(next, "Done"),
    FetchStates.get(next, "GaveUp")
  ])

  if (Option.isNone(read)) return yield* FetchSnapshotError.make({ message: "Fetch snapshot has no state" })

  return read.value
})

export const fetched = (listError: string | undefined): FetchEvent =>
  FetchEvent.cases.Fetched.make(listError === undefined ? {} : { listError })

export const settleFetch = Effect.fn("settleFetch")(function* (first: FetchState, listError: string | undefined) {
  if (!FetchState.guards.Retrying(first)) return first

  return yield* stepFetch(first, fetched(listError))
})

export const reportedFailure = (state: FetchState): boolean =>
  FetchState.guards.GaveUp(state) && isRetryable(state.error)
