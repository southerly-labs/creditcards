import { Effect, Array as EffectArray, Option, Schema } from "effect"
import { HoldState } from "../machine/hold.ts"
import type { Hold } from "../model/holds.ts"
import { holdId } from "../sync/holds.ts"
import { DIFFED_PATHS } from "../sync/merge.ts"

const OFFER_CHANGE = /^offers\.[a-z0-9]+(?:-[a-z0-9]+)*$/u

const decodeJson = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown))

const parsed = (value: string | undefined): Option.Option<unknown> =>
  value === undefined ? Option.some(undefined) : decodeJson(value)

const decidedOn = HoldState.match({
  AwaitingApproval: () => undefined,
  AwaitingConfirmation: () => undefined,
  Approved: (state) => state.on,
  Rejected: (state) => state.on
})

export const holdProblems = (hold: Hold): ReadonlyArray<string> => {
  const at = `sync-holds: ${hold.id}`
  const on = decidedOn(hold.state)

  return [
    ...(EffectArray.some(DIFFED_PATHS, (path) => path === hold.change) || OFFER_CHANGE.test(hold.change)
      ? []
      : [`${at}: ${hold.change} is not a change the sync holds`]),
    ...EffectArray.flatMap(["current", "proposed"] as const, (field) =>
      Option.isSome(parsed(hold[field])) ? [] : [`${at}: ${field} is not JSON`]
    ),
    ...(on === undefined || on >= hold.since ? [] : [`${at}: decided on ${on}, before it was held on ${hold.since}`])
  ]
}

export const holdIdProblems = Effect.fn("holdIdProblems")(function* (holds: ReadonlyArray<Hold>) {
  const problems: Array<string> = []

  for (const hold of holds) {
    const proposed = parsed(hold.proposed)

    if (Option.isNone(proposed)) continue

    const expected = yield* holdId(hold.card, hold.change, proposed.value)

    if (expected !== hold.id)
      problems.push(`sync-holds: ${hold.id} does not match its card, change and proposed value (expected ${expected})`)
  }

  return problems
})
