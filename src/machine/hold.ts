import { Machine } from "@typeonce/effect-machine"
import { Array as EffectArray, Effect, Option, Schema } from "effect"
import { CalendarDate } from "../model/domain.ts"
import { encodedSnapshot } from "./snapshot.ts"

const Decision = { on: CalendarDate, evidence: Schema.NonEmptyString }

export const HoldState = Schema.TaggedUnion({
  AwaitingApproval: {},
  AwaitingConfirmation: {},
  Approved: Decision,
  Rejected: Decision
})

export type HoldState = typeof HoldState.Type

export const HoldKind = Schema.Literals(["approve", "confirm"])

export type HoldKind = typeof HoldKind.Type

export const HoldEvent = Schema.TaggedUnion({
  Proposed: { kind: HoldKind, today: CalendarDate, since: CalendarDate },
  Approve: Decision,
  Reject: Decision,
  Withdrawn: {}
})

export type HoldEvent = typeof HoldEvent.Type

export const HoldStates = Machine.state({
  states: {
    Open: {
      states: {
        Pending: {
          states: {
            AwaitingApproval: HoldState.cases.AwaitingApproval,
            AwaitingConfirmation: HoldState.cases.AwaitingConfirmation
          }
        },
        Approved: HoldState.cases.Approved,
        Rejected: HoldState.cases.Rejected
      }
    },
    Applied: { type: "final" },
    Withdrawn: { type: "final" }
  }
})

export const HoldEvents = Machine.eventsFromSchemas(HoldEvent)

const decided = ({ event }: { readonly event: { readonly on: string; readonly evidence: string } }) => ({
  on: event.on,
  evidence: event.evidence
})

export const HoldMachine = Machine.make({
  id: "Hold",
  root: HoldStates,
  events: HoldEvents,
  branches: {
    proposedForApproval: {
      apply: { target: "Applied" },
      confirm: { target: "Open.Pending.AwaitingConfirmation" },
      wait: { none: true }
    },
    proposedForConfirmation: {
      apply: { target: "Applied" },
      approve: { target: "Open.Pending.AwaitingApproval" },
      wait: { none: true }
    }
  }
}).handle({
  initial: { target: "Open" },
  states: {
    Open: {
      initial: { target: "Open.Pending" },
      on: {
        Approve: { target: "Open.Approved", data: decided },
        Reject: { target: "Open.Rejected", data: decided },
        Withdrawn: { target: "Withdrawn" }
      },
      states: {
        Pending: {
          initial: { target: "Open.Pending.AwaitingApproval" },
          states: {
            AwaitingApproval: {
              on: {
                Proposed: {
                  branches: "proposedForApproval",
                  resolve: ({ event, select }) =>
                    event.kind === "approve"
                      ? select.wait()
                      : event.since < event.today
                        ? select.apply()
                        : select.confirm()
                }
              }
            },
            AwaitingConfirmation: {
              on: {
                Proposed: {
                  branches: "proposedForConfirmation",
                  resolve: ({ event, select }) =>
                    event.kind === "approve"
                      ? select.approve()
                      : event.since < event.today
                        ? select.apply()
                        : select.wait()
                }
              }
            }
          }
        },
        Approved: {
          on: { Proposed: { target: "Applied" } }
        },
        Rejected: {}
      }
    },
    Applied: {},
    Withdrawn: {}
  }
})

export const HoldOutcome = Schema.TaggedUnion({
  Held: { state: HoldState },
  Applied: {},
  Withdrawn: {}
})

export type HoldOutcome = typeof HoldOutcome.Type

type HoldSnapshot = Machine.Snapshot<typeof HoldStates>

export class HoldSnapshotError extends Schema.TaggedError<HoldSnapshotError, { readonly brand: unique symbol }>()(
  "HoldSnapshotError",
  { message: Schema.String }
) {}

const statePath = HoldState.match({
  AwaitingApproval: () => ["Open", "Open.Pending", "Open.Pending.AwaitingApproval"],
  AwaitingConfirmation: () => ["Open", "Open.Pending", "Open.Pending.AwaitingConfirmation"],
  Approved: () => ["Open", "Open.Approved"],
  Rejected: () => ["Open", "Open.Rejected"]
})

const toSnapshot = (state: HoldState) => {
  const paths = statePath(state)

  return Machine.decodeSnapshot(
    HoldMachine,
    encodedSnapshot(EffectArray.map(paths, (path, i) => (i === paths.length - 1 ? { path, value: state } : { path })))
  )
}

const readHeld = (snapshot: HoldSnapshot): Option.Option<HoldState> =>
  Option.firstSomeOf<HoldState>([
    HoldStates.get(snapshot, "Open.Pending.AwaitingApproval"),
    HoldStates.get(snapshot, "Open.Pending.AwaitingConfirmation"),
    HoldStates.get(snapshot, "Open.Approved"),
    HoldStates.get(snapshot, "Open.Rejected")
  ])

const fromSnapshot = Effect.fn("hold.fromSnapshot")(function* (snapshot: HoldSnapshot) {
  if (HoldStates.matches(snapshot, "Applied")) return HoldOutcome.cases.Applied.make({})

  if (HoldStates.matches(snapshot, "Withdrawn")) return HoldOutcome.cases.Withdrawn.make({})
  const held = readHeld(snapshot)

  if (Option.isNone(held)) return yield* HoldSnapshotError.make({ message: "Hold snapshot has no state" })

  return HoldOutcome.cases.Held.make({ state: held.value })
})

export const stepHold = Effect.fn("stepHold")(function* (state: HoldState, event: HoldEvent) {
  const planned = yield* Machine.plan(HoldMachine, yield* toSnapshot(state), event)

  return yield* fromSnapshot(planned.next)
})

export const pendingState = (kind: HoldKind): HoldState =>
  kind === "approve" ? HoldState.cases.AwaitingApproval.make({}) : HoldState.cases.AwaitingConfirmation.make({})

export const isPending = (state: HoldState): boolean =>
  HoldState.guards.AwaitingApproval(state) || HoldState.guards.AwaitingConfirmation(state)
