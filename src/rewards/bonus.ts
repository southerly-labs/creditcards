import { Data } from "effect"
import { createHash } from "node:crypto"
import { parseNumber } from "../cdr/normalise.ts"
import type { BonusTranche } from "../model/schema.ts"
import { required } from "../util/required.ts"
import type { LoyaltyFeature } from "./parse.ts"

export type BonusResult =
  | { readonly _tag: "Parsed"; readonly bonus: ReadonlyArray<BonusTranche> }
  | { readonly _tag: "Review"; readonly reason: string }

export const BonusResult = Data.taggedEnum<BonusResult>()

const clean = (s: string | null | undefined) => (s ?? "").replaceAll(/\s+/gu, " ").trim()

export const bonusText = (features: ReadonlyArray<LoyaltyFeature>): string =>
  features.map((f) => [clean(f.additionalValue), clean(f.additionalInfo)].filter(Boolean).join(" — ")).join("\n")

export const bonusTextHash = (features: ReadonlyArray<LoyaltyFeature>): string =>
  createHash("sha256").update(bonusText(features)).digest("hex").slice(0, 16)

const review = (reason: string): BonusResult => BonusResult.Review({ reason })

export const NO_DETAILS = "CDR names an offer without its details"

export const isResolvableFromCdr = (reason: string): boolean => reason !== NO_DETAILS

const MENTION = /(?<![\d.,$])(up to\s+)?(\d{1,3}(?:,\d{3})+|\d{4,7})\s+(?:[\p{L}\p{S}'’.]+\s+){0,5}?points?\b/giu

const COMPLEX: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:for )?each month\b|\bper month\b/iu, "points for each month of spend"],
  [/cash ?back|\$\s?\d+ back\b/iu, "offer includes cashback"],
  [/auto-redemption|home loan/iu, "offer depends on another product"],
  [
    /\d{1,2}\/\d{1,2}\/\d{2,4}|\b(?:before|until|by|ends?|between)\s+\d{1,2}(?:st|nd|rd|th)?\s+\p{Lu}\p{Ll}+/u,
    "offer has an end date"
  ]
]

const KEEP = /keep (?:your |the )?(?:card|account)(?: open)? for (?:over |more than |at least )?(\d+) months/iu
const YEAR_TWO = /\byear 2\b|\bsecond year\b|\banniversary\b/iu
const YEAR_ONE = /\byear 1\b|\bfirst year\b/iu

const SPEND =
  /spend(?:ing)?\s+(?:a minimum of |at least |over )?\$\s?(\d[\d,]*(?:\.\d+)?)(k)?|\$\s?(\d[\d,]*(?:\.\d+)?)(k)?\+?\s+(?:or more\s+)?spend/iu

const WINDOW = /(\d+)\s+(days?|months?)\b/iu

const money = (digits: string, thousands: string | undefined) =>
  Number(digits.replaceAll(",", "")) * (thousands === undefined ? 1 : 1000)

const tranche = (points: number, clause: string): BonusTranche | string => {
  const keep = clause.match(KEEP)
  const keepMonths = keep ? Number(keep[1]) : undefined
  const spend = clause.match(SPEND)

  const minSpend = spend
    ? spend[1] === undefined
      ? money(required(spend[3]), spend[4])
      : money(spend[1], spend[2])
    : undefined

  const window = spend ? clause.slice(spend.index).match(WINDOW) : null

  const spendDays = window
    ? Number(window[1]) * (required(window[2]).toLowerCase().startsWith("month") ? 30 : 1)
    : undefined

  const yearTwo = (keepMonths !== undefined && keepMonths >= 12) || YEAR_TWO.test(clause)
  const yearOne = (minSpend !== undefined && spendDays !== undefined) || YEAR_ONE.test(clause)

  if (YEAR_ONE.test(clause) && YEAR_TWO.test(clause)) return "one tranche mentions both years"

  if (!yearTwo && !yearOne) return `cannot tell when ${points} points are paid`

  return {
    points,
    year: yearTwo ? 2 : 1,
    ...(minSpend === undefined ? {} : { min_spend: minSpend }),
    ...(spendDays === undefined ? {} : { spend_days: spendDays }),
    ...(keepMonths === undefined ? {} : { keep_months: keepMonths })
  }
}

const parseFeature = (f: LoyaltyFeature): ReadonlyArray<BonusTranche> | string => {
  const text = clean(f.additionalInfo) || clean(f.additionalValue)
  const complex = COMPLEX.find(([re]) => re.test(text))

  if (complex) return complex[1]
  const mentions = [...text.matchAll(MENTION)]
  const headlines = mentions.filter((m) => m[1] !== undefined)

  if (!/\d/u.test(text)) return NO_DETAILS

  if (mentions.length === headlines.length)
    return headlines.length > 0 ? "only an 'up to' total, no tranches" : "no bonus points in text"

  if (headlines.length > 1) return "several 'up to' totals"
  const tranches: Array<BonusTranche> = []

  for (const [i, m] of mentions.entries()) {
    if (m[1] !== undefined) continue
    const points = Number(required(m[2]).replaceAll(",", ""))

    if (!(points >= 1000 && points <= 1_000_000)) return `implausible bonus ${points}`
    const clause = text.slice(m.index + m[0].length, mentions[i + 1]?.index ?? text.length)
    const parsed = tranche(points, clause)

    if (typeof parsed === "string") return parsed
    tranches.push(parsed)
  }

  const total = tranches.reduce((sum, t) => sum + t.points, 0)
  const headline = headlines[0]

  if (headline && Number(required(headline[2]).replaceAll(",", "")) !== total)
    return "tranches do not add up to the 'up to' total"
  const value = parseNumber(f.additionalValue)

  if (value !== undefined && value !== total && !tranches.some((t) => t.points === value))
    return `CDR value ${value} matches neither the total nor a tranche`

  return tranches
}

export const parseBonus = (features: ReadonlyArray<LoyaltyFeature>): BonusResult => {
  const tranches: Array<BonusTranche> = []

  for (const f of features) {
    const parsed = parseFeature(f)

    if (typeof parsed === "string") return review(parsed)
    tranches.push(...parsed)
  }

  if (tranches.filter((t) => t.year === 1).length > 1) return review("several first-year offers")

  if (tranches.filter((t) => t.year === 2).length > 1) return review("several second-year offers")

  return BonusResult.Parsed({ bonus: tranches.toSorted((a, b) => a.year - b.year) })
}
