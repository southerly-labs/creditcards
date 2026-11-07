import { Machine } from "@typeonce/effect-machine"
import { Effect, Option, Schema } from "effect"
import { CalendarDate } from "../model/domain.ts"
import { encodedSnapshot, regionNodes } from "./snapshot.ts"

export const ListingState = Schema.TaggedUnion({
  Listed: {},
  Missing: { since: CalendarDate },
  Delisted: { on: CalendarDate }
})

export type ListingState = typeof ListingState.Type

export const SalesState = Schema.TaggedUnion({
  Selling: {},
  Closed: { on: Schema.optionalKey(CalendarDate) }
})

export type SalesState = typeof SalesState.Type

export const CardLifecycle = Schema.Struct({ listing: ListingState, sales: SalesState })

export type CardLifecycle = typeof CardLifecycle.Type

export const CardLifecycleStates = Machine.state({
  states: {
    Lifecycle: {
      type: "parallel",
      states: {
        listing: {
          states: {
            Listed: ListingState.cases.Listed,
            Missing: ListingState.cases.Missing,
            Delisted: ListingState.cases.Delisted
          }
        },
        sales: {
          states: {
            Selling: SalesState.cases.Selling,
            Closed: SalesState.cases.Closed
          }
        }
      }
    }
  }
})

export const CardLifecycleEvent = Schema.TaggedUnion({
  Seen: {},
  NotSeen: { date: CalendarDate },
  Close: { on: Schema.optionalKey(CalendarDate) },
  Reopen: {}
})

export type CardLifecycleEvent = typeof CardLifecycleEvent.Type

export const CardLifecycleEvents = Machine.eventsFromSchemas(CardLifecycleEvent)

export const CardLifecycleMachine = Machine.make({
  id: "CardLifecycle",
  root: CardLifecycleStates,
  events: CardLifecycleEvents,
  branches: {
    stillMissing: {
      delist: { target: "Lifecycle.listing.Delisted" },
      wait: { none: true }
    }
  }
}).handle({
  initial: { target: "Lifecycle" },
  states: {
    Lifecycle: {
      states: {
        listing: {
          initial: { target: "Lifecycle.listing.Listed" },
          states: {
            Listed: {
              on: {
                NotSeen: { target: "Lifecycle.listing.Missing", data: ({ event }) => ({ since: event.date }) }
              }
            },
            Missing: {
              on: {
                Seen: { target: "Lifecycle.listing.Listed" },
                NotSeen: {
                  branches: "stillMissing",
                  resolve: ({ state, event, select }) =>
                    state.since < event.date ? select.delist({ data: { on: state.since } }) : select.wait()
                }
              }
            },
            Delisted: {
              on: { Seen: { target: "Lifecycle.listing.Listed" } }
            }
          }
        },
        sales: {
          initial: { target: "Lifecycle.sales.Selling" },
          states: {
            Selling: {
              on: {
                Close: {
                  target: "Lifecycle.sales.Closed",
                  data: ({ event }) => (event.on === undefined ? {} : { on: event.on })
                }
              }
            },
            Closed: {
              on: { Reopen: { target: "Lifecycle.sales.Selling" } }
            }
          }
        }
      }
    }
  }
})

type LifecycleSnapshot = Machine.Snapshot<typeof CardLifecycleStates>

export class LifecycleSnapshotError extends Schema.TaggedError<
  LifecycleSnapshotError,
  { readonly brand: unique symbol }
>()("LifecycleSnapshotError", { message: Schema.String }) {}

const readListing = (snapshot: LifecycleSnapshot): Option.Option<ListingState> =>
  Option.firstSomeOf<ListingState>([
    CardLifecycleStates.get(snapshot, "Lifecycle.listing.Listed"),
    CardLifecycleStates.get(snapshot, "Lifecycle.listing.Missing"),
    CardLifecycleStates.get(snapshot, "Lifecycle.listing.Delisted")
  ])

const readSales = (snapshot: LifecycleSnapshot): Option.Option<SalesState> =>
  Option.firstSomeOf<SalesState>([
    CardLifecycleStates.get(snapshot, "Lifecycle.sales.Selling"),
    CardLifecycleStates.get(snapshot, "Lifecycle.sales.Closed")
  ])

export const fromSnapshot = Effect.fn("fromSnapshot")(function* (snapshot: LifecycleSnapshot) {
  const lifecycle = Option.all({ listing: readListing(snapshot), sales: readSales(snapshot) })

  if (Option.isNone(lifecycle))
    return yield* LifecycleSnapshotError.make({ message: "Snapshot has no listing or sales state" })

  return lifecycle.value
})

export const toSnapshot = (lifecycle: CardLifecycle) =>
  Machine.decodeSnapshot(CardLifecycleMachine, encodedSnapshot(regionNodes("Lifecycle", lifecycle)))

export const stepLifecycle = Effect.fn("stepLifecycle")(function* (
  lifecycle: CardLifecycle,
  event: CardLifecycleEvent
) {
  const planned = yield* Machine.plan(CardLifecycleMachine, yield* toSnapshot(lifecycle), event)

  return yield* fromSnapshot(planned.next)
})

export const initialLifecycle: CardLifecycle = {
  listing: ListingState.cases.Listed.make({}),
  sales: SalesState.cases.Selling.make({})
}

export interface FlatLifecycle {
  readonly status: "active" | "closed" | "discontinued"
  readonly closed?: string
  readonly missing_since?: string
  readonly discontinued?: string
}

const listingFromFlat = (card: FlatLifecycle): ListingState => {
  if (card.status === "discontinued" && card.discontinued !== undefined)
    return ListingState.cases.Delisted.make({ on: card.discontinued })

  if (card.missing_since !== undefined) return ListingState.cases.Missing.make({ since: card.missing_since })

  return ListingState.cases.Listed.make({})
}

const salesFromFlat = (card: FlatLifecycle): SalesState =>
  card.status === "closed" || card.closed !== undefined
    ? SalesState.cases.Closed.make(card.closed === undefined ? {} : { on: card.closed })
    : SalesState.cases.Selling.make({})

export const lifecycleFromFlat = (card: FlatLifecycle): CardLifecycle => ({
  listing: listingFromFlat(card),
  sales: salesFromFlat(card)
})

export const flatFromLifecycle = (lifecycle: CardLifecycle): FlatLifecycle => {
  const { listing, sales } = lifecycle
  const delisted = ListingState.guards.Delisted(listing) ? listing : undefined
  const missing = ListingState.guards.Missing(listing) ? listing : undefined
  const closed = SalesState.guards.Closed(sales) ? sales : undefined

  return {
    status: delisted !== undefined ? "discontinued" : closed !== undefined ? "closed" : "active",
    ...(closed?.on === undefined ? {} : { closed: closed.on }),
    ...(missing === undefined ? {} : { missing_since: missing.since }),
    ...(delisted === undefined ? {} : { discontinued: delisted.on })
  }
}
