import { Console, DateTime, Effect, Array as EffectArray, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import type { Hold } from "../model/holds.ts"
import { HoldEvent, HoldOutcome, stepHold } from "../machine/hold.ts"
import { Store, StoreError } from "../store/Store.ts"

export const decideHold = Effect.fn("decideHold")(function* (
  id: string,
  decision: "approve" | "reject",
  evidence: string
) {
  const store = yield* Store
  const holds = (yield* store.load).holds ?? []
  const hold = Option.getOrUndefined(EffectArray.findFirst(holds, (entry) => entry.id === id))

  if (hold === undefined) return yield* StoreError.make({ file: id, message: "Unknown hold" })
  const on = DateTime.formatIsoDateUtc(yield* DateTime.now)

  const outcome = yield* stepHold(
    hold.state,
    decision === "approve"
      ? HoldEvent.cases.Approve.make({ on, evidence })
      : HoldEvent.cases.Reject.make({ on, evidence })
  )

  if (!HoldOutcome.guards.Held(outcome)) return yield* StoreError.make({ file: id, message: "Hold is no longer open" })
  const decided: Hold = { ...hold, state: outcome.state }

  yield* store.writeHolds(EffectArray.map(holds, (entry) => (entry.id === id ? decided : entry)))

  return decided
})

const decide = (decision: "approve" | "reject") =>
  Command.make(
    decision,
    { id: Argument.String("id"), evidence: Flag.String("evidence") },
    Effect.fn(function* ({ id, evidence }) {
      yield* decideHold(id, decision, evidence)
      yield* Console.log(`Recorded ${decision} for ${id}; the next sync applies it`)

      return undefined
    })
  ).pipe(
    Command.withDescription(
      decision === "approve"
        ? "Approve a held change so the next sync applies it"
        : "Reject a held change so the sync keeps the current value"
    )
  )

const list = Command.make(
  "list",
  {},
  Effect.fn(function* () {
    for (const hold of (yield* (yield* Store).load).holds ?? []) {
      yield* Console.log(
        EffectArray.join(
          [
            `${hold.id} ${hold.state._tag} ${hold.card} ${hold.change}`,
            `  reason: ${hold.reason} (since ${hold.since})`,
            `  current: ${hold.current ?? "—"}`,
            `  proposed: ${hold.proposed ?? "—"}`,
            ...(hold.history === undefined ? [] : [`  history: ${hold.history}`])
          ],
          "\n"
        )
      )
    }
  })
).pipe(Command.withDescription("List changes the sync is holding"))

export const heldCommand = Command.make("held").pipe(
  Command.withDescription("Review changes held back by the sync guardrails"),
  Command.withSubcommands([list, decide("approve"), decide("reject")])
)
