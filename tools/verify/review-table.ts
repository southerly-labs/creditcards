import { BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Array as EffectArray } from "effect"
import {
  needsReview,
  type ReadOutcome,
  ReviewEvent,
  type ReviewOutcome,
  SourceReview,
  stepReview
} from "../../src/machine/review.ts"
import { ParsedComment, parseComment } from "../../src/review/commands.ts"
import { tlaConstant, tlaModule, tlaRows } from "./tla.ts"

const OLD = "1111111111111111"
const NEW = "2222222222222222"
const TODAY = "2026-11-02"

const STATES = [
  ["Unread", "-"],
  ["Parsed", "-"],
  ["Unreadable", "-"],
  ["Reviewed", "none"],
  ["Reviewed", "present"],
  ["Stale", "none"],
  ["Stale", "present"]
] as const

type StateInput = (typeof STATES)[number]

const stateOf = ([tag, outcome]: StateInput): SourceReview => {
  if (tag === "Unread") return SourceReview.cases.Unread.make({})

  if (tag === "Parsed") return SourceReview.cases.Parsed.make({ hash: OLD })

  if (tag === "Unreadable") return SourceReview.cases.Unreadable.make({ hash: OLD })

  const review = { hash: OLD, outcome: outcome === "none" ? "none" : "present", on: TODAY } as const

  return tag === "Reviewed" ? SourceReview.cases.Reviewed.make(review) : SourceReview.cases.Stale.make(review)
}

const hashOf = (state: SourceReview): string => {
  if (SourceReview.guards.Unread(state)) return "none"

  return state.hash === OLD ? "old" : "event"
}

const outcomeOf = (state: SourceReview): string =>
  SourceReview.guards.Reviewed(state) || SourceReview.guards.Stale(state) ? state.outcome : "-"

type EventInput =
  | { readonly kind: "Read"; readonly same: boolean; readonly outcome: ReadOutcome }
  | { readonly kind: "Stamp"; readonly same: boolean; readonly outcome: ReviewOutcome }

const EVENTS: ReadonlyArray<EventInput> = [
  ...EffectArray.flatMap([true, false], (same) =>
    EffectArray.map(["parsed", "nothing", "unreadable"] as const, (outcome): EventInput => ({
      kind: "Read",
      same,
      outcome
    }))
  ),
  ...EffectArray.flatMap([true, false], (same) =>
    EffectArray.map(["none", "present"] as const, (outcome): EventInput => ({ kind: "Stamp", same, outcome }))
  )
]

const eventOf = (input: EventInput): ReviewEvent => {
  const hash = input.same ? OLD : NEW

  return input.kind === "Read"
    ? ReviewEvent.cases.Read.make({ hash, outcome: input.outcome })
    : ReviewEvent.cases.Stamp.make({ hash, outcome: input.outcome, on: TODAY })
}

const reviewRow = Effect.fn("reviewRow")(function* (state: StateInput, input: EventInput) {
  const next = yield* stepReview(stateOf(state), eventOf(input))

  return [state[0], state[1], input.kind, input.same, input.outcome, next._tag, hashOf(next), outcomeOf(next)]
})

const accepted = (body: string) => ParsedComment.$is("Commands")(parseComment(body))

const program = Effect.gen(function* () {
  const rows = yield* Effect.forEach(
    EffectArray.flatMap(STATES, (state) => EffectArray.map(EVENTS, (input) => [state, input] as const)),
    ([state, input]) => reviewRow(state, input)
  )

  const needs = EffectArray.map(STATES, (state) => [state[0], state[1], needsReview(stateOf(state))])

  yield* Console.log(
    tlaModule(
      "RewardsReviewCode",
      ["src/machine/review.ts", "src/review/commands.ts (parseComment)"],
      [
        tlaRows("ReviewRows", rows),
        tlaRows("NeedsReviewRows", needs),
        tlaConstant("BareStampAccepted", accepted("/earn-none example/card")),
        tlaConstant("PinnedStampAccepted", accepted(`/earn-none example/card@${NEW}`))
      ]
    )
  )
})

BunRuntime.runMain(program)
