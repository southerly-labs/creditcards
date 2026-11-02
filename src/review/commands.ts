import { Data } from "effect"

export type ReviewCommand =
  | { readonly _tag: "Approve"; readonly id: string; readonly note: string }
  | { readonly _tag: "Reject"; readonly id: string; readonly note: string }
  | { readonly _tag: "EarnNone"; readonly cards: ReadonlyArray<string> }
  | { readonly _tag: "BonusNone"; readonly cards: ReadonlyArray<string> }

export const ReviewCommand = Data.taggedEnum<ReviewCommand>()

export type ParsedComment =
  | { readonly _tag: "Commands"; readonly commands: ReadonlyArray<ReviewCommand> }
  | { readonly _tag: "Invalid"; readonly errors: ReadonlyArray<string> }

export const ParsedComment = Data.taggedEnum<ParsedComment>()

const HOLD_ID = /^[0-9a-f]{12}$/u

const CARD_KEY = /^[a-z0-9-]+\/[a-z0-9-]+$/u

export const COMMAND_HELP = [
  "`/approve <hold id> [why]`",
  "`/reject <hold id> <why>`",
  "`/earn-none <issuer/card>...`",
  "`/bonus-none <issuer/card>...`"
].join(", ")

const parseHold = (tag: "Approve" | "Reject", words: ReadonlyArray<string>, line: string): ReviewCommand | string => {
  const [id = "", ...rest] = words
  const note = rest.join(" ")

  if (!HOLD_ID.test(id)) return `\`${line}\`: expected a 12-character hold id`

  if (tag === "Reject" && note === "") return `\`${line}\`: say why the change is rejected`

  return tag === "Approve" ? ReviewCommand.Approve({ id, note }) : ReviewCommand.Reject({ id, note })
}

const parseCards = (tag: "EarnNone" | "BonusNone", cards: ReadonlyArray<string>, line: string) => {
  if (cards.length === 0) return `\`${line}\`: name at least one issuer/card`
  const bad = cards.find((card) => !CARD_KEY.test(card))

  if (bad !== undefined) return `\`${line}\`: \`${bad}\` is not an issuer/card key`

  return tag === "EarnNone" ? ReviewCommand.EarnNone({ cards }) : ReviewCommand.BonusNone({ cards })
}

const PARSERS: Readonly<
  Record<string, (words: ReadonlyArray<string>, cards: ReadonlyArray<string>, line: string) => ReviewCommand | string>
> = {
  "/approve": (words, _cards, line) => parseHold("Approve", words, line),
  "/reject": (words, _cards, line) => parseHold("Reject", words, line),
  "/earn-none": (_words, cards, line) => parseCards("EarnNone", cards, line),
  "/bonus-none": (_words, cards, line) => parseCards("BonusNone", cards, line)
}

const parseLine = (line: string): ReviewCommand | string => {
  const [name = "", ...words] = line.split(/\s+/u)
  const cards = words.map((word) => word.replaceAll("`", ""))

  const parse = PARSERS[name.toLowerCase()]

  return parse === undefined ? `\`${line}\`: unknown command; use ${COMMAND_HELP}` : parse(words, cards, line)
}

export const parseComment = (body: string): ParsedComment => {
  const lines = body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^\/[a-z]/iu.test(line))

  const parsed = lines.map((line) => parseLine(line))
  const errors = parsed.filter((item) => typeof item === "string")

  return errors.length > 0
    ? ParsedComment.Invalid({ errors })
    : ParsedComment.Commands({ commands: parsed.filter((item) => typeof item !== "string") })
}
