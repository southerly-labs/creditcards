import { Array as EffectArray, String as EffectString } from "effect"

export const EARN_REVIEW_INTRO = "cards have earn rates the parser could not read"

export const BONUS_REVIEW_INTRO = "cards have signup bonuses the parser could not split by year"

export interface ListedHashes {
  readonly earn: ReadonlyMap<string, string>
  readonly bonus: ReadonlyMap<string, string>
}

type Section = "earn" | "bonus" | "other"

interface ListedItem {
  readonly section: Section
  readonly card: string
  readonly hash: string
}

const LISTED_ITEM = /^- \[[ x]\] `(?<card>[^`@]+)@(?<hash>[0-9a-f]{16})`/iu

const sectionOf = (line: string, current: Section): Section => {
  if (EffectString.includes(EARN_REVIEW_INTRO)(line)) return "earn"

  if (EffectString.includes(BONUS_REVIEW_INTRO)(line)) return "bonus"

  return current
}

const itemsIn = (section: Section, line: string): ReadonlyArray<ListedItem> => {
  const groups = LISTED_ITEM.exec(line)?.groups
  const card = groups?.["card"]
  const hash = groups?.["hash"]

  return card === undefined || hash === undefined ? [] : [{ section, card, hash }]
}

const hashesIn = (items: ReadonlyArray<ListedItem>, section: Section): ReadonlyMap<string, string> =>
  new Map(
    EffectArray.map(
      EffectArray.filter(items, (item) => item.section === section),
      (item) => [item.card, item.hash] as const
    )
  )

const START: Section = "other"

const step = (current: Section, line: string): readonly [Section, ReadonlyArray<ListedItem>] => {
  const section = sectionOf(line, current)

  return [section, itemsIn(section, line)]
}

export const listedHashes = (issueBody: string): ListedHashes => {
  const lines = EffectArray.map(EffectString.split(issueBody, /\r?\n/u), (line) => EffectString.trim(line))
  const [, nested] = EffectArray.mapAccum(lines, START, step)
  const items = EffectArray.flatten(nested)

  return { earn: hashesIn(items, "earn"), bonus: hashesIn(items, "bonus") }
}
