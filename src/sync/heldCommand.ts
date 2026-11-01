import { Console, DateTime, Effect } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import type { Hold } from "../model/holds.ts"
import { Store, StoreError } from "../store/Store.ts"

const decide = (decision: "approve" | "reject") =>
  Command.make(
    decision,
    { id: Argument.String("id"), evidence: Flag.String("evidence") },
    Effect.fn(function* ({ id, evidence }) {
      const store = yield* Store
      const holds = (yield* store.load).holds ?? []

      if (!holds.some((hold) => hold.id === id)) return yield* new StoreError({ file: id, message: "Unknown hold" })
      const decided_on = DateTime.formatIsoDateUtc(yield* DateTime.now)

      const decided = (hold: Hold): Hold => ({ ...hold, decision, decided_on, evidence })

      yield* store.writeHolds(holds.map((hold) => (hold.id === id ? decided(hold) : hold)))
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
        [
          `${hold.id} ${hold.kind} ${hold.card} ${hold.change}${hold.decision === undefined ? "" : ` [${hold.decision}]`}`,
          `  reason: ${hold.reason} (since ${hold.since})`,
          `  current: ${hold.current ?? "—"}`,
          `  proposed: ${hold.proposed ?? "—"}`,
          ...(hold.history === undefined ? [] : [`  history: ${hold.history}`])
        ].join("\n")
      )
    }
  })
).pipe(Command.withDescription("List changes the sync is holding"))

export const heldCommand = Command.make("held").pipe(
  Command.withDescription("Review changes held back by the sync guardrails"),
  Command.withSubcommands([list, decide("approve"), decide("reject")])
)
