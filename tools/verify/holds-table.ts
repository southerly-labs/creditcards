import { BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Array as EffectArray } from "effect"
import { Digest } from "effect/crypto"
import { HoldEvent, HoldOutcome, HoldState, stepHold } from "../../src/machine/hold.ts"
import type { Hold } from "../../src/model/holds.ts"
import { type HoldCandidate, type HoldKind, holdId, resolveHolds } from "../../src/sync/holds.ts"
import { tlaModule, tlaRows } from "./tla.ts"

const CARD = "example/card"
const CHANGE = "fees.annual"
const TODAY = "2026-11-02"
const EARLIER = "2026-11-01"
const PROPOSED = 400

const PRIOR = ["AwaitingApproval", "AwaitingConfirmation", "Approved", "Rejected"] as const

type Prior = (typeof PRIOR)[number]

const stateOf = (prior: Prior, since: string): HoldState => {
  if (prior === "AwaitingApproval") return HoldState.cases.AwaitingApproval.make({})

  if (prior === "AwaitingConfirmation") return HoldState.cases.AwaitingConfirmation.make({})

  return prior === "Approved"
    ? HoldState.cases.Approved.make({ on: since, evidence: "verify extractor" })
    : HoldState.cases.Rejected.make({ on: since, evidence: "verify extractor" })
}

const candidateOf = (kind: HoldKind): HoldCandidate => ({
  change: CHANGE,
  reason: "fees.annual 100 → 400",
  kind,
  current: 100,
  proposed: PROPOSED
})

const entryOf = Effect.fn("entryOf")(function* (prior: Prior, since: string) {
  return {
    id: yield* holdId(CARD, CHANGE, PROPOSED),
    card: CARD,
    change: CHANGE,
    reason: "fees.annual 100 → 400",
    current: "100",
    proposed: `${PROPOSED}`,
    since,
    state: stateOf(prior, since)
  } satisfies Hold
})

const resolveRow = Effect.fn("resolveRow")(function* (
  prior: Prior | "none",
  earlier: boolean,
  kind: HoldKind | "none"
) {
  const since = earlier ? EARLIER : TODAY
  const entries = prior === "none" ? [] : [yield* entryOf(prior, since)]
  const candidates = kind === "none" ? [] : [candidateOf(kind)]
  const result = yield* resolveHolds({ card: CARD, candidates, entries, date: TODAY })
  const verdict = result.apply.length > 0 ? "apply" : result.revert.length > 0 ? "revert" : "none"
  const next = result.holds[0]?.state._tag ?? "gone"
  const nextSince = result.holds[0] === undefined ? "none" : result.holds[0].since === TODAY ? "today" : "kept"

  return [prior, earlier, kind, verdict, next, nextSince, result.holds.length]
})

const decideRow = Effect.fn("decideRow")(function* (prior: Prior, decision: "approve" | "reject") {
  const event =
    decision === "approve"
      ? HoldEvent.cases.Approve.make({ on: TODAY, evidence: "verify extractor" })
      : HoldEvent.cases.Reject.make({ on: TODAY, evidence: "verify extractor" })

  const outcome = yield* stepHold(stateOf(prior, EARLIER), event)

  return [prior, decision, HoldOutcome.guards.Held(outcome) ? outcome.state._tag : "refused"]
})

export const holdTables = Effect.gen(function* () {
  const resolveInputs = EffectArray.flatMap(["none", ...PRIOR] as const, (prior) =>
    EffectArray.flatMap([true, false], (earlier) =>
      EffectArray.map(["none", "approve", "confirm"] as const, (kind) => [prior, earlier, kind] as const)
    )
  )

  const resolveRows = yield* Effect.forEach(resolveInputs, ([prior, earlier, kind]) => resolveRow(prior, earlier, kind))

  const decideRows = yield* Effect.forEach(
    EffectArray.flatMap(PRIOR, (prior) => EffectArray.map(["approve", "reject"] as const, (d) => [prior, d] as const)),
    ([prior, decision]) => decideRow(prior, decision)
  )

  return [tlaRows("ResolveRows", resolveRows), tlaRows("DecideRows", decideRows)]
})

const program = Effect.gen(function* () {
  yield* Console.log(
    tlaModule(
      "SyncHoldsCode",
      ["src/machine/hold.ts", "src/sync/holds.ts (resolveHolds)", "src/sync/heldCommand.ts (decideHold)"],
      yield* holdTables
    )
  )
})

if (import.meta.main) BunRuntime.runMain(program.pipe(Effect.provide(Digest.layerWebCrypto)))
