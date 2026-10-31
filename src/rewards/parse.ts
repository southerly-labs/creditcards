import { Data } from "effect"
import { required } from "../util/required.ts"
import { createHash } from "node:crypto"
import type { EarnRate } from "../model/schema.ts"

export interface LoyaltyFeature {
  readonly additionalValue?: string | null | undefined
  readonly additionalInfo?: string | null | undefined
}

export type ParseResult =
  | { readonly _tag: "Parsed"; readonly earn: ReadonlyArray<EarnRate> }
  | { readonly _tag: "Review"; readonly reason: string }

export const ParseResult = Data.taggedEnum<ParseResult>()

const clean = (s: string | null | undefined) => (s ?? "").replaceAll(/\s+/gu, " ").trim()

export const loyaltyText = (features: ReadonlyArray<LoyaltyFeature>): string =>
  features.map((f) => [clean(f.additionalValue), clean(f.additionalInfo)].filter(Boolean).join(" — ")).join("\n")

export const loyaltyTextHash = (features: ReadonlyArray<LoyaltyFeature>): string =>
  createHash("sha256").update(loyaltyText(features)).digest("hex").slice(0, 16)

const review = (reason: string): ParseResult => ParseResult.Review({ reason })

const MENTION = /(?<![\d.,$])(\d+(?:\.\d+)?)\s+(?:[A-Za-z&]+\s+){0,3}?points?\b/giu
const PER_DOLLAR = /per \$\s?1\b|per dollar|for every (?:AU)?\$\s?[\d.]+|for every dollar|per (?:AU)?\$\s?1\.00\b/iu
const DIVISOR = /for every (?:AU)?\$\s?(\d+(?:\.\d+)?)/iu

const COMPLEX = new RegExp(
  [
    "qantas products",
    "virgin australia",
    "international",
    "overseas",
    "government",
    "grocer",
    "dining",
    "supermarket",
    "petrol",
    "webjet",
    "selected",
    "taxation",
    "utilit",
    "eats",
    "streaming",
    "retailer",
    "david jones",
    "travel",
    "airline",
    "hotel",
    "online",
    "foreign",
    "business spend",
    "\\btax\\b",
    "except",
    "excluding",
    "bonus",
    "extra",
    "additional",
    "cash ?back",
    "%",
    "\\bup to [\\d.]+k?\\s+(?:\\w+\\s+)?points",
    "capped at [\\d,]+ (?:points|per)",
    "calendar year",
    "per year",
    "annual",
    "\\bor\\b \\d",
    "opt[- ]in"
  ].join("|"),
  "iu"
)

const NEXT_TIER = /\b(?:over|above) \$|thereafter|further|once you spend|after spending/iu
const CAP_HERE = /\b(?:up to(?: and including)?|on the first|first) \$\s?([\d,]+)/iu
const THRESHOLD = /\b(?:over|above|once you spend|after spending) \$\s?([\d,]+)/iu

const SPEND_CAP = /capped at \$\s?([\d,]+)/iu

const amount = (s: string) => Number(s.replaceAll(",", ""))

export const parseEarn = (features: ReadonlyArray<LoyaltyFeature>): ParseResult => {
  const text = loyaltyText(features)

  if (!/\d/u.test(text)) return review("no earn rate in text")

  if (COMPLEX.test(text)) return review("category, bonus or conditional earn")

  if (!PER_DOLLAR.test(text)) return review("no per-dollar earn rate")

  const mentions = [...text.matchAll(MENTION)]

  if (mentions.length === 0) return review("no earn rate in text")

  if (mentions.length > 3) return review("too many rates")

  const clauses = mentions.map((m, i) => text.slice(m.index, mentions[i + 1]?.index ?? text.length))
  const tiers: Array<EarnRate> = []

  for (let i = 0; i < mentions.length; i++) {
    const clause = required(clauses[i])

    if (i > 0 && !NEXT_TIER.test(clause)) return review("several rates that are not spend tiers")
    const divisor = Number(clause.match(DIVISOR)?.[1] ?? 1)
    const rate = Math.round((Number(required(mentions[i])[1]) / divisor) * 10_000) / 10_000

    if (!(rate > 0 && rate <= 10)) return review(`implausible rate ${rate}`)
    const capHere = clause.slice(required(mentions[i])[0].length).match(CAP_HERE)?.[1]
    const capNext = clauses[i + 1]?.match(THRESHOLD)?.[1]
    const cap = capHere ?? capNext
    tiers.push({ rate, ...(cap != null && cap !== "" ? { cap_monthly: amount(cap) } : {}) })
  }

  const spendCap = text.match(SPEND_CAP)?.[1]
  const last = required(tiers.at(-1))

  if (spendCap != null && spendCap !== "" && last.cap_monthly === undefined)
    tiers[tiers.length - 1] = { ...last, cap_monthly: amount(spendCap) }

  for (let i = 1; i < tiers.length; i++) {
    const prev = required(tiers[i - 1]).cap_monthly
    const cap = required(tiers[i]).cap_monthly

    if (prev === undefined) return review("spend tiers without a threshold")

    if (cap !== undefined && cap <= prev) return review("spend tiers out of order")
  }

  return ParseResult.Parsed({ earn: tiers })
}
