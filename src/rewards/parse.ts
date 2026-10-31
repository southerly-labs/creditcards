import { createHash } from "node:crypto"
import type { EarnRate } from "../model/schema.ts"

// Conservative rule-based extraction of earn rates from CDR LOYALTY_PROGRAM
// text. It only accepts a single base rate or simple spend tiers; anything
// else (category rates, bonuses, exclusions, cashback, points caps) is left
// for a person to review. A wrong earn rate is worse than a missing one.

export interface LoyaltyFeature {
  readonly additionalValue?: string | null | undefined
  readonly additionalInfo?: string | null | undefined
}

export type ParseResult =
  | { readonly _tag: "Parsed"; readonly earn: ReadonlyArray<EarnRate> }
  | { readonly _tag: "Review"; readonly reason: string }

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim()

export const loyaltyText = (features: ReadonlyArray<LoyaltyFeature>): string =>
  features.map((f) => [clean(f.additionalValue), clean(f.additionalInfo)].filter(Boolean).join(" — ")).join("\n")

export const loyaltyTextHash = (features: ReadonlyArray<LoyaltyFeature>): string =>
  createHash("sha256").update(loyaltyText(features)).digest("hex").slice(0, 16)

const review = (reason: string): ParseResult => ({ _tag: "Review", reason })

// "1.5 Reward Points", "0.75 Qantas Points", "1 Amplify point", "2 points"
const MENTION = /(?<![\d.,$])(\d+(?:\.\d+)?)\s+(?:[A-Za-z&]+\s+){0,3}?points?\b/gi
const PER_DOLLAR = /per \$\s?1\b|per dollar|for every (?:AU)?\$\s?[\d.]+|for every dollar|per (?:AU)?\$\s?1\.00\b/i
const DIVISOR = /for every (?:AU)?\$\s?(\d+(?:\.\d+)?)/i

// Signals of spend categories, bonuses or conditions the parser does not model.
const COMPLEX = new RegExp([
  "qantas products", "virgin australia", "international", "overseas", "government", "grocer", "dining",
  "supermarket", "petrol", "webjet", "selected", "taxation", "utilit", "eats", "streaming", "retailer",
  "david jones", "travel", "airline", "hotel", "online", "foreign", "business spend", "\\btax\\b",
  "except", "excluding", "bonus", "extra", "additional", "cash ?back", "%", "\\bup to [\\d.]+k?\\s+(?:\\w+\\s+)?points",
  "capped at [\\d,]+ (?:points|per)", "calendar year", "per year", "annual", "\\bor\\b \\d", "opt[- ]in"
].join("|"), "i")

const NEXT_TIER = /\b(?:over|above) \$|thereafter|further|once you spend|after spending/i
const CAP_HERE = /\b(?:up to(?: and including)?|on the first|first) \$\s?([\d,]+)/i
const THRESHOLD = /\b(?:over|above|once you spend|after spending) \$\s?([\d,]+)/i
// "Qantas Points are capped at $50,000 per card per statement period": a spend
// cap on the last tier. (Points caps like "capped at 20,000 points" are COMPLEX.)
const SPEND_CAP = /capped at \$\s?([\d,]+)/i

const amount = (s: string) => Number(s.replace(/,/g, ""))

export const parseEarn = (features: ReadonlyArray<LoyaltyFeature>): ParseResult => {
  const text = loyaltyText(features)
  if (!/\d/.test(text)) return review("no earn rate in text")
  if (COMPLEX.test(text)) return review("category, bonus or conditional earn")
  if (!PER_DOLLAR.test(text)) return review("no per-dollar earn rate")

  const mentions = [...text.matchAll(MENTION)]
  if (mentions.length === 0) return review("no earn rate in text")
  if (mentions.length > 3) return review("too many rates")

  const clauses = mentions.map((m, i) => text.slice(m.index, mentions[i + 1]?.index ?? text.length))
  const tiers: Array<EarnRate> = []
  for (let i = 0; i < mentions.length; i++) {
    const clause = clauses[i]!
    if (i > 0 && !NEXT_TIER.test(clause)) return review("several rates that are not spend tiers")
    const divisor = Number(clause.match(DIVISOR)?.[1] ?? 1)
    const rate = Math.round((Number(mentions[i]![1]) / divisor) * 10_000) / 10_000
    if (!(rate > 0 && rate <= 10)) return review(`implausible rate ${rate}`)
    const capHere = clause.slice(mentions[i]![0].length).match(CAP_HERE)?.[1]
    const capNext = clauses[i + 1]?.match(THRESHOLD)?.[1]
    const cap = capHere ?? capNext
    tiers.push({ rate, ...(cap ? { cap_monthly: amount(cap) } : {}) })
  }
  const spendCap = text.match(SPEND_CAP)?.[1]
  const last = tiers[tiers.length - 1]!
  if (spendCap && last.cap_monthly === undefined) tiers[tiers.length - 1] = { ...last, cap_monthly: amount(spendCap) }
  for (let i = 1; i < tiers.length; i++) {
    const prev = tiers[i - 1]!.cap_monthly
    const cap = tiers[i]!.cap_monthly
    if (prev === undefined) return review("spend tiers without a threshold")
    if (cap !== undefined && cap <= prev) return review("spend tiers out of order")
  }
  return { _tag: "Parsed", earn: tiers }
}
