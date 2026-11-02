import { Effect } from "effect"
import { stamp, stampBonus } from "../rewards/review.ts"
import { decideHold } from "../sync/heldCommand.ts"
import { ParsedComment, parseComment, ReviewCommand } from "./commands.ts"

export interface CommentSource {
  readonly by: string
  readonly url: string
}

const evidence = (note: string, fallback: string, source: CommentSource) =>
  `${note === "" ? fallback : note} (by ${source.by}, ${source.url})`

const run = Effect.fn("runReviewCommand")(function* (command: ReviewCommand, source: CommentSource) {
  if (ReviewCommand.$is("Approve")(command) || ReviewCommand.$is("Reject")(command)) {
    const approve = ReviewCommand.$is("Approve")(command)
    const why = evidence(command.note, "approved in the review issue", source)
    const hold = yield* decideHold(command.id, approve ? "approve" : "reject", why)

    return `${approve ? "approved" : "rejected"} hold ${hold.id}: ${hold.card} ${hold.change} (${hold.reason})`
  }

  if (ReviewCommand.$is("EarnNone")(command)) {
    yield* stamp(command.cards, true)

    return `no fixed earn rate: ${command.cards.join(", ")}`
  }

  yield* stampBonus(command.cards, true)

  return `no current signup offer: ${command.cards.join(", ")}`
})

export const applyComment = Effect.fn("applyComment")(function* (body: string, source: CommentSource) {
  const parsed = parseComment(body)

  if (ParsedComment.$is("Invalid")(parsed)) return parsed

  const applied = yield* Effect.forEach(parsed.commands, (command) => run(command, source))

  return { _tag: "Applied" as const, applied }
})
