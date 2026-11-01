import type { Api } from "../../src/api/contract.ts"
import { annualPoints, meetsSpendTarget } from "../../src/model/benefit.ts"
import type { Card, Program } from "../../src/model/schema.ts"
import { offerStatus } from "../../src/offers/project.ts"
import type { Offer, OfferComponent } from "../../src/offers/schema.ts"

export type PublicCard = Omit<Card, "locked">

export type PublicProgram = Omit<Program, "aliases" | "priority"> & { readonly id: string }

export interface Entry {
  readonly id: string
  readonly issuerId: string
  readonly issuer: string
  readonly card: PublicCard
  readonly program: PublicProgram | undefined
}

export type IntroRate = Extract<OfferComponent, { readonly kind: "intro_rate" }>

export type SignupPoints = Extract<OfferComponent, { readonly kind: "signup_points" }>

export type FeeDiscount = Extract<OfferComponent, { readonly kind: "fee_discount" }>

const isIntroRate = (c: OfferComponent): c is IntroRate => c.kind === "intro_rate"

const isSignupPoints = (c: OfferComponent): c is SignupPoints => c.kind === "signup_points"

const isYearLongFeeDiscount = (c: OfferComponent): c is FeeDiscount =>
  c.kind === "fee_discount" && c.fee === "annual" && (c.months ?? 12) >= 12

const makeEntry = (api: Api, issuerId: string, issuer: string, cardId: string, card: PublicCard): Entry => {
  const programId = card.rewards?.program
  const program = programId === undefined ? undefined : api.programs[programId]

  return {
    id: `${issuerId}/${cardId}`,
    issuerId,
    issuer,
    card,
    program: programId !== undefined && program !== undefined ? { id: programId, ...program } : undefined
  }
}

export const entriesFrom = (api: Api): ReadonlyArray<Entry> =>
  Object.entries(api.issuers).flatMap(([issuerId, issuer]) =>
    Object.entries(issuer.cards).map(([cardId, card]) => makeEntry(api, issuerId, issuer.name, cardId, card))
  )

export const currentOffers = (card: PublicCard, today: string): ReadonlyArray<Offer> =>
  (card.offers ?? []).filter((o) => ["within_window", "undated"].includes(offerStatus(o, today)))

export const introRates = (card: PublicCard, today: string): ReadonlyArray<IntroRate> =>
  currentOffers(card, today).flatMap((o) => o.components.filter(isIntroRate))

export const transferOffer = (card: PublicCard, today: string): IntroRate | undefined =>
  introRates(card, today)
    .filter((r) => r.applies_to !== "purchase")
    .toSorted((a, b) => (b.months ?? 0) - (a.months ?? 0) || a.rate - b.rate)[0]

export const signupTranches = (card: PublicCard, today: string): ReadonlyArray<SignupPoints> =>
  currentOffers(card, today)
    .find((o) => o.components.some(isSignupPoints))
    ?.components.filter(isSignupPoints) ?? []

export const isBaseRate = (category: string | undefined) => category === undefined || category === ""

export const baseEarnRate = (card: PublicCard) => card.rewards?.earn?.find((e) => isBaseRate(e.category))?.rate

export interface Valuation {
  readonly centsPerPoint: number | undefined
  readonly yearlyPoints: number | undefined
  readonly earnValue: number | undefined
  readonly bonusPoints: number | undefined
  readonly firstYearBonusPoints: number | undefined
  readonly bonusMissed: boolean
  readonly bonusValue: number | undefined
  readonly firstYearBonusValue: number | undefined
  readonly fee: number | undefined
  readonly firstYearFee: number | undefined
  readonly ongoing: number | undefined
  readonly firstYear: number | undefined
}

const dollars = (points: number | undefined, cents: number | undefined) =>
  points === undefined || cents === undefined ? undefined : Math.round(points * cents) / 100

const sumPoints = (tranches: ReadonlyArray<SignupPoints>) => {
  const total = tranches.reduce((sum, t) => sum + t.points, 0)

  return total === 0 ? undefined : total
}

export const firstYearFee = (card: PublicCard, today: string) =>
  currentOffers(card, today).flatMap((o) => o.components.filter(isYearLongFeeDiscount))[0]?.payable ?? card.fees.annual

export const value = (
  entry: Entry,
  monthlySpend: number,
  overrides: Readonly<Record<string, number>>,
  today: string
): Valuation => {
  const { card, program } = entry
  const cents = program === undefined ? undefined : (overrides[program.id] ?? program.cents_per_point)

  const yearlyPoints =
    program === undefined ? undefined : annualPoints(card.rewards?.earn ?? [], monthlySpend, card.rewards?.earn_rules)

  const earnValue = program === undefined ? 0 : dollars(yearlyPoints, cents)
  const tranches = signupTranches(card, today)
  const bonusPoints = sumPoints(tranches) ?? (tranches.length === 0 ? card.rewards?.bonus_points : undefined)
  const firstYearTranches = tranches.filter((t) => (t.year ?? 1) === 1)
  const firstYearBonusPoints = sumPoints(firstYearTranches)
  const earnedBonusPoints = sumPoints(firstYearTranches.filter((t) => meetsSpendTarget(monthlySpend, t)))
  const fee = card.fees.annual
  const feeYearOne = firstYearFee(card, today)
  const firstYearBonusValue = dollars(earnedBonusPoints, cents) ?? 0
  const ongoing = earnValue === undefined || fee === undefined ? undefined : earnValue - fee

  return {
    centsPerPoint: cents,
    yearlyPoints,
    earnValue,
    bonusPoints,
    firstYearBonusPoints,
    bonusMissed: firstYearBonusPoints !== undefined && earnedBonusPoints !== firstYearBonusPoints,
    bonusValue: dollars(bonusPoints, cents),
    firstYearBonusValue,
    fee,
    firstYearFee: feeYearOne,
    ongoing,
    firstYear:
      earnValue === undefined || feeYearOne === undefined ? undefined : earnValue + firstYearBonusValue - feeYearOne
  }
}

export interface Ranked {
  readonly entry: Entry
  readonly valuation: Valuation
}

type Key = number | undefined

const ascending = (a: Key, b: Key) => {
  if (a === undefined) return b === undefined ? 0 : 1

  if (b === undefined) return -1

  return a - b
}

const descending = (a: Key, b: Key) => {
  if (a === undefined) return b === undefined ? 0 : 1

  if (b === undefined) return -1

  return b - a
}

export const goalIds = ["value", "bonus", "travel", "rate", "transfer", "free"] as const

export type GoalId = (typeof goalIds)[number]

export interface Goal {
  readonly label: string
  readonly sentence: string
  readonly keep: (r: Ranked, today: string) => boolean
  readonly order: (a: Ranked, b: Ranked, today: string) => number
}

const byOngoing = (a: Ranked, b: Ranked) =>
  descending(a.valuation.ongoing, b.valuation.ongoing) || ascending(a.valuation.fee, b.valuation.fee)

export const goals: Record<GoalId, Goal> = {
  value: {
    label: "Most back every year",
    sentence: "the most back every year",
    keep: () => true,
    order: byOngoing
  },
  bonus: {
    label: "Biggest first year",
    sentence: "the biggest first year",
    keep: (r) => r.valuation.firstYearBonusPoints !== undefined,
    order: (a, b) => descending(a.valuation.firstYear, b.valuation.firstYear) || byOngoing(a, b)
  },
  travel: {
    label: "No fees overseas",
    sentence: "no fees when I spend overseas",
    keep: (r) => r.entry.card.fees.foreign_txn_pct === 0,
    order: byOngoing
  },
  rate: {
    label: "Low interest",
    sentence: "a low rate if I carry a balance",
    keep: (r) => r.entry.card.rates.purchase !== undefined,
    order: (a, b) =>
      ascending(a.entry.card.rates.purchase, b.entry.card.rates.purchase) || ascending(a.valuation.fee, b.valuation.fee)
  },
  transfer: {
    label: "Balance transfer",
    sentence: "to move a balance and pay it down",
    keep: (r, today) => transferOffer(r.entry.card, today) !== undefined,
    order: (a, b, today) => {
      const x = transferOffer(a.entry.card, today)
      const y = transferOffer(b.entry.card, today)

      return (
        descending(x?.months, y?.months) || ascending(x?.rate, y?.rate) || ascending(a.valuation.fee, b.valuation.fee)
      )
    }
  },
  free: {
    label: "No annual fee",
    sentence: "a card with no annual fee",
    keep: (r) => r.entry.card.fees.annual === 0,
    order: (a, b) => byOngoing(a, b) || ascending(a.entry.card.rates.purchase, b.entry.card.rates.purchase)
  }
}

export const isGoalId = (text: string | null): text is GoalId => goalIds.some((id) => id === text)

export const rank = (rows: ReadonlyArray<Ranked>, goal: GoalId, today: string): ReadonlyArray<Ranked> => {
  const { keep, order } = goals[goal]

  return rows
    .filter((r) => keep(r, today))
    .toSorted((a, b) => order(a, b, today) || a.entry.card.name.localeCompare(b.entry.card.name))
}
