import { Machine } from "@typeonce/effect-machine"
import { Effect, Option, Schema } from "effect"
import { Offer } from "../offers/schema.ts"
import { encodedSnapshot } from "./snapshot.ts"

export const OfferSlot = Schema.TaggedUnion({
  Absent: {},
  Generated: { offer: Offer },
  Manual: { offer: Offer }
})

export type OfferSlot = typeof OfferSlot.Type

export const OfferSlotEvent = Schema.TaggedUnion({
  Regenerated: { offer: Schema.optionalKey(Offer) }
})

export type OfferSlotEvent = typeof OfferSlotEvent.Type

export const OfferSlotStates = Machine.state({
  states: { Absent: OfferSlot.cases.Absent, Generated: OfferSlot.cases.Generated, Manual: OfferSlot.cases.Manual }
})

export const OfferSlotMachine = Machine.make({
  id: "OfferSlot",
  root: OfferSlotStates,
  events: Machine.eventsFromSchemas(OfferSlotEvent),
  branches: {
    regenerated: {
      generated: { target: "Generated" },
      absent: { target: "Absent" },
      unchanged: { none: true }
    }
  }
}).handle({
  initial: { target: "Absent" },
  states: {
    Absent: {
      on: {
        Regenerated: {
          branches: "regenerated",
          resolve: ({ event, select }) =>
            event.offer === undefined
              ? select.unchanged()
              : select.generated({ decoded: true, data: OfferSlot.cases.Generated.make({ offer: event.offer }) })
        }
      }
    },
    Generated: {
      on: {
        Regenerated: {
          branches: "regenerated",
          resolve: ({ event, select }) =>
            event.offer === undefined
              ? select.absent({ data: {} })
              : select.generated({ decoded: true, data: OfferSlot.cases.Generated.make({ offer: event.offer }) })
        }
      }
    },
    Manual: {}
  }
})

export class OfferSlotError extends Schema.TaggedError<OfferSlotError, { readonly brand: unique symbol }>()(
  "OfferSlotError",
  { message: Schema.String }
) {}

export const stepOfferSlot = Effect.fn("stepOfferSlot")(function* (slot: OfferSlot, event: OfferSlotEvent) {
  const snapshot = yield* Machine.decodeSnapshot(OfferSlotMachine, encodedSnapshot([{ path: slot._tag, value: slot }]))

  const { next } = yield* Machine.plan(OfferSlotMachine, snapshot, event)

  const read = Option.firstSomeOf<OfferSlot>([
    OfferSlotStates.get(next, "Absent"),
    OfferSlotStates.get(next, "Generated"),
    OfferSlotStates.get(next, "Manual")
  ])

  if (Option.isNone(read)) return yield* OfferSlotError.make({ message: "Offer slot snapshot has no state" })

  return read.value
})

export const slotOf = (offer: Offer | undefined): OfferSlot =>
  offer === undefined
    ? OfferSlot.cases.Absent.make({})
    : offer.source === "manual"
      ? OfferSlot.cases.Manual.make({ offer })
      : OfferSlot.cases.Generated.make({ offer })

export const offerIn = (slot: OfferSlot): Offer | undefined => (OfferSlot.guards.Absent(slot) ? undefined : slot.offer)
