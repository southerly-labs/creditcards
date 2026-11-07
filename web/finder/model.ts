import type { Api } from "../../src/api/contract.ts"
import { annualPoints, meetsSpendTarget } from "../../src/model/benefit.ts"
import type { Program } from "../../src/model/schema.ts"
import type { PublicCard } from "../../src/api/contract.ts"
import { offerStatus } from "../../src/offers/project.ts"
import type { Offer, OfferComponent } from "../../src/offers/schema.ts"
import { Array as EffectArray, Record as EffectRecord, Option, Order, String as EffectString, pipe } from "effect"
import { dual } from "effect/Function"

export type { PublicCard }

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
  EffectArray.flatMap(EffectRecord.toEntries(api.issuers), ([issuerId, issuer]) =>
    EffectArray.map(EffectRecord.toEntries(issuer.cards), ([cardId, card]) =>
      makeEntry(api, issuerId, issuer.name, cardId, card)
    )
  )

export const currentOffers = dual<
  (today: string) => (card: PublicCard) => ReadonlyArray<Offer>,
  (card: PublicCard, today: string) => ReadonlyArray<Offer>
>(2, (card: PublicCard, today: string): ReadonlyArray<Offer> =>
  EffectArray.filter(card.offers ?? [], (o) => ["within_window", "undated"].includes(offerStatus(o, today)))
)

export const introRates = dual<
  (today: string) => (card: PublicCard) => ReadonlyArray<IntroRate>,
  (card: PublicCard, today: string) => ReadonlyArray<IntroRate>
>(2, (card: PublicCard, today: string): ReadonlyArray<IntroRate> =>
  EffectArray.flatMap(currentOffers(card, today), (o) => EffectArray.filter(o.components, isIntroRate))
)

export const transferOffer = dual<
  (today: string) => (card: PublicCard) => IntroRate | undefined,
  (card: PublicCard, today: string) => IntroRate | undefined
>(2, (card: PublicCard, today: string): IntroRate | undefined =>
  Option.getOrUndefined(
    EffectArray.head(
      EffectArray.sort(
        EffectArray.filter(introRates(card, today), (r) => r.applies_to !== "purchase"),
        Order.combine(
          Order.mapInput(Order.flip(Order.Number), (r: IntroRate) => r.months ?? 0),
          Order.mapInput(Order.Number, (r: IntroRate) => r.rate)
        )
      )
    )
  )
)

const signupOffer = (card: PublicCard, today: string) =>
  Option.getOrUndefined(
    EffectArray.findFirst(currentOffers(card, today), (o) => EffectArray.some(o.components, isSignupPoints))
  )

export const signupTranches = dual<
  (today: string) => (card: PublicCard) => ReadonlyArray<SignupPoints>,
  (card: PublicCard, today: string) => ReadonlyArray<SignupPoints>
>(2, (card: PublicCard, today: string): ReadonlyArray<SignupPoints> =>
  EffectArray.filter(signupOffer(card, today)?.components ?? [], isSignupPoints)
)

export const isBaseRate = (category: string | undefined) => category === undefined || category === ""

export const baseEarnRate = (card: PublicCard) =>
  Option.getOrUndefined(EffectArray.findFirst(card.rewards?.earn ?? [], (e) => isBaseRate(e.category)))?.rate

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
  const total = EffectArray.reduce(tranches, 0, (sum, t) => sum + t.points)

  return total === 0 ? undefined : total
}

export const firstYearFee = dual<
  (today: string) => (card: PublicCard) => number | undefined,
  (card: PublicCard, today: string) => number | undefined
>(
  2,
  (card: PublicCard, today: string): number | undefined =>
    EffectArray.flatMap(currentOffers(card, today), (o) => EffectArray.filter(o.components, isYearLongFeeDiscount))[0]
      ?.payable ?? card.fees.annual
)

const valueImpl = (
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
  const bonusPoints = sumPoints(tranches)
  const unverified = signupOffer(card, today)?.source === "cdr"
  const firstYearTranches = unverified ? [] : EffectArray.filter(tranches, (t) => (t.year ?? 1) === 1)
  const firstYearBonusPoints = sumPoints(firstYearTranches)
  const earnedBonusPoints = sumPoints(EffectArray.filter(firstYearTranches, (t) => meetsSpendTarget(monthlySpend, t)))
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

export const value = dual<
  (monthlySpend: number, overrides: Readonly<Record<string, number>>, today: string) => (entry: Entry) => Valuation,
  (entry: Entry, monthlySpend: number, overrides: Readonly<Record<string, number>>, today: string) => Valuation
>(4, valueImpl)

export interface Ranked {
  readonly entry: Entry
  readonly valuation: Valuation
}

type Key = number | undefined

const undefinedLast = (defined: Order.Order<number>): Order.Order<Key> =>
  Order.make((a, b) => (a === undefined ? (b === undefined ? 0 : 1) : b === undefined ? -1 : defined(a, b)))

const ascending = <A>(key: (a: A) => Key): Order.Order<A> => Order.mapInput(undefinedLast(Order.Number), key)

const descending = <A>(key: (a: A) => Key): Order.Order<A> =>
  Order.mapInput(undefinedLast(Order.flip(Order.Number)), key)

export const goalIds = ["value", "bonus", "travel", "rate", "transfer", "free"] as const

export type GoalId = (typeof goalIds)[number]

export interface Goal {
  readonly label: string
  readonly sentence: string
  readonly keep: (r: Ranked, today: string) => boolean
  readonly order: (today: string) => Order.Order<Ranked>
}

const byFee = ascending((r: Ranked) => r.valuation.fee)

const byPurchaseRate = ascending((r: Ranked) => r.entry.card.rates.purchase)

const byOngoing = Order.combine(
  descending((r: Ranked) => r.valuation.ongoing),
  byFee
)

const byCardName = Order.make<Ranked>((a, b) => pipe(a.entry.card.name, EffectString.localeCompare(b.entry.card.name)))

export const goals: Record<GoalId, Goal> = {
  value: {
    label: "Most back every year",
    sentence: "the most back every year",
    keep: () => true,
    order: () => byOngoing
  },
  bonus: {
    label: "Biggest first year",
    sentence: "the biggest first year",
    keep: (r) => r.valuation.firstYearBonusPoints !== undefined,
    order: () =>
      Order.combine(
        descending((r: Ranked) => r.valuation.firstYear),
        byOngoing
      )
  },
  travel: {
    label: "No fees overseas",
    sentence: "no fees when I spend overseas",
    keep: (r) => r.entry.card.fees.foreign_txn_pct === 0,
    order: () => byOngoing
  },
  rate: {
    label: "Low interest",
    sentence: "a low rate if I carry a balance",
    keep: (r) => r.entry.card.rates.purchase !== undefined,
    order: () => Order.combine(byPurchaseRate, byFee)
  },
  transfer: {
    label: "Balance transfer",
    sentence: "to move a balance and pay it down",
    keep: (r, today) => transferOffer(r.entry.card, today) !== undefined,
    order: (today) =>
      Order.combineAll([
        descending((r: Ranked) => transferOffer(r.entry.card, today)?.months),
        ascending((r: Ranked) => transferOffer(r.entry.card, today)?.rate),
        byFee
      ])
  },
  free: {
    label: "No annual fee",
    sentence: "a card with no annual fee",
    keep: (r) => r.entry.card.fees.annual === 0,
    order: () => Order.combine(byOngoing, byPurchaseRate)
  }
}

export const isGoalId = (text: string | null): text is GoalId => EffectArray.some(goalIds, (id) => id === text)

const rankImpl = (rows: ReadonlyArray<Ranked>, goal: GoalId, today: string): ReadonlyArray<Ranked> => {
  const { keep, order } = goals[goal]

  return EffectArray.sort(
    EffectArray.filter(rows, (r) => keep(r, today)),
    Order.combine(order(today), byCardName)
  )
}

export const rank = dual<
  (goal: GoalId, today: string) => (rows: ReadonlyArray<Ranked>) => ReadonlyArray<Ranked>,
  (rows: ReadonlyArray<Ranked>, goal: GoalId, today: string) => ReadonlyArray<Ranked>
>(3, rankImpl)
