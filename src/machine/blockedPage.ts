import { Machine } from "@typeonce/effect-machine"
import { DateTime, Effect, Option, Schema } from "effect"
import { dual } from "effect/Function"
import { CalendarDate } from "../model/domain.ts"
import { encodedSnapshot } from "./snapshot.ts"

const Blocked = { reason: Schema.NonEmptyString, evidence: Schema.NonEmptyString, since: CalendarDate }

export const PageState = Schema.TaggedUnion({
  Readable: {},
  Blocked
})

export type PageState = typeof PageState.Type

export const PageEvent = Schema.TaggedUnion({
  Read: {},
  Failed: { error: Schema.NonEmptyString, date: CalendarDate }
})

export type PageEvent = typeof PageEvent.Type

export const PageStates = Machine.state({
  states: { Readable: PageState.cases.Readable, Blocked: PageState.cases.Blocked }
})

export const BLOCKED_REASON = "Issuer page unreadable"

export const BlockedPageMachine = Machine.make({
  id: "BlockedPage",
  root: PageStates,
  events: Machine.eventsFromSchemas(PageEvent),
  branches: {
    stillFailing: {
      changed: { update: "Blocked" },
      same: { none: true }
    }
  }
}).handle({
  initial: { target: "Readable" },
  states: {
    Readable: {
      on: {
        Failed: {
          target: "Blocked",
          data: ({ event }) => ({ reason: BLOCKED_REASON, evidence: event.error, since: event.date })
        }
      }
    },
    Blocked: {
      on: {
        Read: { target: "Readable" },
        Failed: {
          branches: "stillFailing",
          resolve: ({ state, event, select }) =>
            event.error === state.evidence
              ? select.same()
              : select.changed({ data: { reason: state.reason, evidence: event.error, since: state.since } })
        }
      }
    }
  }
})

export class PageSnapshotError extends Schema.TaggedError<PageSnapshotError, { readonly brand: unique symbol }>()(
  "PageSnapshotError",
  { message: Schema.String }
) {}

export const stepPage = Effect.fn("stepPage")(function* (state: PageState, event: PageEvent) {
  const snapshot = yield* Machine.decodeSnapshot(
    BlockedPageMachine,
    encodedSnapshot([{ path: state._tag, value: state }])
  )

  const { next } = yield* Machine.plan(BlockedPageMachine, snapshot, event)

  const read = Option.firstSomeOf<PageState>([PageStates.get(next, "Readable"), PageStates.get(next, "Blocked")])

  if (Option.isNone(read)) return yield* PageSnapshotError.make({ message: "Page snapshot has no state" })

  return read.value
})

export const BLOCKED_ATTENTION_DAYS = 30

const DAY_MS = 86_400_000

const daysBetween = (from: string, to: string) =>
  (DateTime.toEpochMillis(DateTime.makeUnsafe(to)) - DateTime.toEpochMillis(DateTime.makeUnsafe(from))) / DAY_MS

const pageAttentionImpl = (previous: PageState, next: PageState, date: string): string | undefined => {
  if (PageState.guards.Blocked(previous) && PageState.guards.Readable(next))
    return "Previously blocked page is readable again"

  if (!PageState.guards.Blocked(next)) return undefined

  if (PageState.guards.Blocked(previous) && previous.evidence !== next.evidence) return "Blocked page status changed"

  return daysBetween(next.since, date) >= BLOCKED_ATTENTION_DAYS
    ? "Page has been blocked for 30 days; review the source"
    : undefined
}

export const pageAttention = dual<
  (next: PageState, date: string) => (previous: PageState) => string | undefined,
  (previous: PageState, next: PageState, date: string) => string | undefined
>(3, pageAttentionImpl)

export const pageStateOf = (blocked: Omit<typeof PageState.cases.Blocked.Type, "_tag"> | undefined): PageState =>
  blocked === undefined ? PageState.cases.Readable.make({}) : PageState.cases.Blocked.make(blocked)

export const knownBlockedOf = (state: PageState) =>
  PageState.guards.Blocked(state) ? { reason: state.reason, evidence: state.evidence, since: state.since } : undefined
