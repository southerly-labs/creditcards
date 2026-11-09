import { Effect, Array as EffectArray, String as EffectString } from "effect"
import { stamp, stampBonus } from "../rewards/review.ts"
import { decideHold } from "../sync/heldCommand.ts"
import { ParsedComment, parseComment, ReviewCommand } from "./commands.ts"
import { listedHashes } from "./listed.ts"

export interface CommentSource {
  readonly by: string
  readonly url: string
  readonly issue: string
}

const evidence = (note: string, fallback: string, source: CommentSource) =>
  `${note === "" ? fallback : note} (by ${source.by}, ${source.url})`

const pinnedTarget = (card: string, listed: ReadonlyMap<string, string>) => {
  const hash = EffectString.includes("@")(card) ? undefined : listed.get(card)

  return hash === undefined ? card : `${card}@${hash}`
}

const pinToListed = (cards: ReadonlyArray<string>, listed: ReadonlyMap<string, string>) =>
  EffectArray.map(cards, (card) => pinnedTarget(card, listed))

const run = Effect.fn("runReviewCommand")(function* (command: ReviewCommand, source: CommentSource) {
  if (ReviewCommand.$is("Approve")(command) || ReviewCommand.$is("Reject")(command)) {
    const approve = ReviewCommand.$is("Approve")(command)
    const why = evidence(command.note, "approved in the review issue", source)
    const hold = yield* decideHold(command.id, approve ? "approve" : "reject", why)

    return `${approve ? "approved" : "rejected"} hold ${hold.id}: ${hold.card} ${hold.change} (${hold.reason})`
  }

  const listed = listedHashes(source.issue)

  if (ReviewCommand.$is("EarnNone")(command)) {
    yield* stamp(pinToListed(command.cards, listed.earn), true)

    return `no fixed earn rate: ${EffectArray.join(command.cards, ", ")}`
  }

  yield* stampBonus(pinToListed(command.cards, listed.bonus), true)

  return `no current signup offer: ${EffectArray.join(command.cards, ", ")}`
})

export const applyComment = Effect.fn("applyComment")(function* (body: string, source: CommentSource) {
  const parsed = parseComment(body)

  if (ParsedComment.$is("Invalid")(parsed)) return parsed

  const applied = yield* Effect.forEach(parsed.commands, (command) => run(command, source))

  return { _tag: "Applied" as const, applied }
})
