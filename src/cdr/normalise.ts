import { defined } from "../util/defined.ts"
import {
  Predicate,
  Array as EffectArray,
  String as EffectString,
  Record as EffectRecord,
  pipe,
  Option,
  Order
} from "effect"
import { required } from "../util/required.ts"
import type { CdrOfferInputs } from "../offers/build.ts"
import type { Card, CardType, IntroOffer, Network, Program } from "../model/schema.ts"
import type { Fee, ProductDetail } from "./schema.ts"
import { dual } from "effect/Function"

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] }

export type NormalisedCard = Mutable<Omit<Card, "first_seen">>

export interface ProgramIndex {
  readonly programs: ReadonlyArray<{
    readonly id: string
    readonly program: Program
    readonly patterns: ReadonlyArray<RegExp>
  }>
}

const byPriorityDesc = Order.flip(
  Order.mapInput(Order.Number, (entry: { readonly program: Program }) => entry.program.priority ?? 0)
)

export const makeProgramIndex = (programs: Record<string, Program>): ProgramIndex => ({
  programs: EffectArray.sort(
    EffectArray.map(EffectRecord.toEntries(programs), ([id, program]) => ({
      id,
      program,
      patterns: EffectArray.map(program.aliases ?? [], (a) => new RegExp(a, "iu"))
    })),
    byPriorityDesc
  )
})

export interface NormaliseContext {
  readonly issuerSlug: string
  readonly brandName: string
  readonly programs: ProgramIndex
}

export interface NormaliseResult {
  readonly card: NormalisedCard
  readonly offers: CdrOfferInputs

  readonly fallbackProgram: string | undefined
}

export const parseNumber = (value: string | null | undefined): number | undefined => {
  if (value == null) return undefined
  const cleaned = pipe(value, EffectString.replaceAll(/[$,\s]/gu, ""))

  if (cleaned === "") return undefined
  const n = Number(cleaned)

  return Number.isFinite(n) ? n : undefined
}

export const toPercent = (value: string | null | undefined): number | undefined => {
  const n = parseNumber(value)

  if (n === undefined) return undefined

  return round(n > 1 ? n : n * 100, 4)
}

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp

const timesPerYearImpl = (period: string | null | undefined, name: string): number | undefined => {
  const iso = pipe(
    Option.fromNullishOr(period),
    Option.map(EffectString.trim),
    Option.flatMap(EffectString.match(/^P(\d+)([YMWD])$/iu))
  )

  if (Option.isSome(iso)) {
    const n = Number(iso.value[1])

    if (n === 0) return undefined
    const periods: Record<string, number> = { Y: 1, M: 12, W: 52 }
    const perYear = periods[EffectString.toUpperCase(required(iso.value[2]))]

    return perYear === undefined ? undefined : perYear / n
  }

  const text = `${period ?? ""} ${name}`

  if (/month/iu.test(text)) return 12

  if (/annual|year/iu.test(text)) return 1

  return undefined
}

export const timesPerYear = dual<
  (name: string) => (period: string | null | undefined) => number | undefined,
  (period: string | null | undefined, name: string) => number | undefined
>(2, timesPerYearImpl)

export const isoMonths = (value: string | null | undefined): number | undefined => {
  const present = Option.fromNullishOr(value)
  const iso = pipe(present, Option.map(EffectString.trim), Option.flatMap(EffectString.match(/^P(\d+)([YM])$/iu)))

  if (Option.isSome(iso))
    return Number(iso.value[1]) * (EffectString.toUpperCase(required(iso.value[2])) === "Y" ? 12 : 1)

  const text = Option.flatMap(present, EffectString.match(/(\d+)\s*months?/iu))

  return Option.isSome(text) ? Number(text.value[1]) : undefined
}

const fixedAmount = (fee: Fee) => parseNumber(fee.fixedAmount?.amount ?? fee.amount)

const feeRate = (fee: Fee) =>
  toPercent(fee.rateBased?.rate ?? fee.transactionRate ?? fee.balanceRate ?? fee.accruedRate)

const NOT_CARD_FEE =
  /additional|supplementary|secondary|companion|direct|optional|opt[- ]?in|paper|statement|replacement|late/iu

const ADDITIONAL_CARD = /additional|supplementary|secondary/iu

const annualised = (fees: ReadonlyArray<Fee>) => {
  let total: number | undefined

  for (const fee of fees) {
    const amount = fixedAmount(fee)
    const times = timesPerYear(fee.additionalValue, fee.name ?? "")

    if (amount === undefined || times === undefined) continue
    total = round((total ?? 0) + amount * times, 2)
  }

  return total
}

export const annualFee = (fees: ReadonlyArray<Fee>) =>
  annualised(EffectArray.filter(fees, (f) => f.feeType === "PERIODIC" && !NOT_CARD_FEE.test(f.name ?? "")))

export const additionalCardFee = (fees: ReadonlyArray<Fee>) =>
  annualised(EffectArray.filter(fees, (f) => f.feeType === "PERIODIC" && ADDITIONAL_CARD.test(f.name ?? "")))

export const firstYearFee = (fees: ReadonlyArray<Fee>): number | undefined => {
  const discounted = EffectArray.some(
    fees,
    (f) =>
      f.feeType === "PERIODIC" &&
      !NOT_CARD_FEE.test(f.name ?? "") &&
      EffectArray.some(f.discounts ?? [], (d) =>
        /first year free|\$0 (annual fee )?(in|for) the first year|no annual fee (in|for) the first year/iu.test(
          d.description ?? ""
        )
      )
  )

  return discounted ? 0 : undefined
}

const feeName = (fee: Fee) => pipe(fee.name ?? "", EffectString.replaceAll("_", " "))

const FX_NAME = /international|overseas|foreign|currency conversion|currency other than|cross[- ]border/iu
const NOT_FX = /replacement|atm|cash|withdraw|deposit|emergency|card fee|statement|travel\/procurement/iu

const fxFeeType = (fee: Fee) =>
  !["CASH_ADVANCE", "REPLACEMENT", "WITHDRAWAL", "DEPOSIT", "PERIODIC"].includes(fee.feeType) ||
  (fee.feeType === "WITHDRAWAL" && /currency conversion/iu.test(feeName(fee)))

export const foreignTransactionFee = (fees: ReadonlyArray<Fee>): number | undefined => {
  const candidates = EffectArray.filter(
    fees,
    (f) =>
      fxFeeType(f) && !NOT_FX.test(feeName(f)) && (FX_NAME.test(feeName(f)) || FX_NAME.test(f.additionalInfo ?? ""))
  )

  const rates = candidates
    .values()
    .map((f) => feeRate(f) ?? (fixedAmount(f) === 0 ? 0 : undefined))
    .filter((r): r is number => r !== undefined)
    .toArray()

  return rates.length > 0 ? Math.max(...rates) : undefined
}

export const cashAdvanceFee = (fees: ReadonlyArray<Fee>) => {
  const cash = EffectArray.filter(
    fees,
    (f) => f.feeType === "CASH_ADVANCE" && !/overseas|international/iu.test(f.name ?? "")
  )

  const pct = Option.getOrUndefined(
    EffectArray.findFirst(
      EffectArray.map(cash, (fee) => feeRate(fee)),
      (r) => r !== undefined
    )
  )

  const min = Option.getOrUndefined(
    EffectArray.findFirst(
      EffectArray.map(cash, (f) => parseNumber(f.fixedAmount?.amount ?? f.amount)),
      (r) => r !== undefined
    )
  )

  return { pct, min }
}

const LATE_NAME = /late\s*pay|missed\s*payment/iu

const isLateFee = (fee: Fee) =>
  fee.feeType === "LATE_PAYMENT" ||
  (["EVENT", "OTHER"].includes(fee.feeType) && LATE_NAME.test(feeName(fee)) && !/reminder/iu.test(feeName(fee)))

export const latePaymentFee = (fees: ReadonlyArray<Fee>) =>
  fees
    .values()
    .filter((fee) => isLateFee(fee))
    .map((fee) => fixedAmount(fee))
    .find((r) => r !== undefined)

type LendingRate = NonNullable<ProductDetail["lendingRates"]>[number]

const ongoingRate = (rates: ReadonlyArray<LendingRate>, type: string, exclude?: RegExp) =>
  rates
    .values()
    .filter((r) => r.lendingRateType === type && isoMonths(r.additionalValue) === undefined)
    .filter((r) => exclude === undefined || !exclude.test(r.additionalValue ?? ""))
    .map((r) => toPercent(r.rate))
    .find((r) => r !== undefined)

export const introOffers = (rates: ReadonlyArray<LendingRate>): Array<IntroOffer> => {
  const offers: Array<IntroOffer> = []

  for (const r of rates) {
    const promo =
      r.lendingRateType === "INTRODUCTORY" ||
      (["BALANCE_TRANSFER", "PURCHASE"].includes(r.lendingRateType) && isoMonths(r.additionalValue) !== undefined)

    if (!promo) continue
    const rate = toPercent(r.rate)

    if (rate === undefined) continue
    const text = EffectString.toLowerCase(`${r.additionalInfo ?? ""} ${r.additionalValue ?? ""}`)
    const bt = r.lendingRateType === "BALANCE_TRANSFER" || pipe(text, EffectString.includes("balance transfer"))
    const purchase = r.lendingRateType === "PURCHASE" || pipe(text, EffectString.includes("purchase"))
    const applies_to = bt && purchase ? "both" : purchase ? "purchase" : "balance_transfer"
    const months = isoMonths(r.additionalValue) ?? isoMonths(r.additionalInfo)
    const offer = { applies_to, rate, ...(months !== undefined && months <= 60 ? { months } : {}) } as const

    if (
      !EffectArray.some(
        offers,
        (o) => o.applies_to === offer.applies_to && o.rate === offer.rate && o.months === months
      )
    ) {
      offers.push(offer)
    }
  }

  return offers
}

export const interestFreeDays = (p: ProductDetail): number | undefined => {
  for (const f of p.features ?? []) {
    if (f.featureType !== "INTEREST_FREE") continue
    const iso = Option.flatMap(Option.fromNullishOr(f.additionalValue), EffectString.match(/^P(\d+)D$/u))

    if (Option.isSome(iso)) return Number(iso.value[1])

    const text = pipe(
      `${f.additionalValue ?? ""} ${f.additionalInfo ?? ""}`,
      EffectString.match(/up to (\d+) (?:interest[- ]free )?days/iu)
    )

    if (Option.isSome(text)) return Number(text.value[1])
  }

  return undefined
}

export const cardType = (p: ProductDetail): CardType => {
  if (/corporate|procurement|purchasing|commercial|virtual card|travel (and|&) expense/iu.test(p.name))
    return "corporate"

  const business =
    /business/iu.test(p.name) ||
    EffectArray.some(
      p.eligibility ?? [],
      (e) => e.eligibilityType === "BUSINESS" || e.eligibilityType === "MIN_TURNOVER"
    )

  return business ? "business" : "personal"
}

const NETWORKS: ReadonlyArray<readonly [Network, RegExp]> = [
  ["amex", /american express|\bamex\b/iu],
  ["mastercard", /master ?card/iu],
  ["visa", /\bvisa\b/iu],
  ["unionpay", /union ?pay/iu]
]

const networkImpl = (p: ProductDetail, brandName: string): Network | undefined => {
  if (/american express/iu.test(brandName)) return "amex"
  const fromName = EffectArray.filter(NETWORKS, ([, re]) => re.test(p.name))

  if (fromName.length === 1) return required(fromName[0])[0]

  const text = EffectArray.join(
    EffectArray.filter(
      [p.description, ...EffectArray.flatMap(p.features ?? [], (f) => [f.additionalValue, f.additionalInfo])],
      Predicate.isNotNullish
    ),
    " "
  )

  const counts = NETWORKS.values()
    .map(
      ([n, re]) => [n, (Option.getOrNull(pipe(text, EffectString.match(new RegExp(re, "giu")))) ?? []).length] as const
    )
    .filter(([n, c]) => c > 0 && n !== "amex")
    .toArray()

  return counts.length === 1 ? required(counts[0])[0] : undefined
}

export const network = dual<
  (brandName: string) => (p: ProductDetail) => Network | undefined,
  (p: ProductDetail, brandName: string) => Network | undefined
>(2, networkImpl)

export const matchProgram = dual<
  (text: string) => (index: ProgramIndex) => string | undefined,
  (index: ProgramIndex, text: string) => string | undefined
>(
  2,
  (index: ProgramIndex, text: string): string | undefined =>
    Option.getOrUndefined(
      EffectArray.findFirst(index.programs, (p) => EffectArray.some(p.patterns, (re) => re.test(text)))
    )?.id
)

export const issuerProgramId = (issuerSlug: string) => `${issuerSlug}-rewards`

const rewards = (p: ProductDetail, ctx: NormaliseContext) => {
  const loyalty = EffectArray.filter(p.features ?? [], (f) => f.featureType === "LOYALTY_PROGRAM")

  if (loyalty.length === 0) return { rewards: undefined, fallback: undefined }
  let fallback: string | undefined
  const ids: Array<string> = []

  for (const f of loyalty) {
    const id = matchProgram(ctx.programs, f.additionalValue ?? "") ?? matchProgram(ctx.programs, f.additionalInfo ?? "")
    const resolved = id ?? (fallback = issuerProgramId(ctx.issuerSlug))

    if (!ids.includes(resolved)) ids.push(resolved)
  }

  const [program, ...partners] = ids

  return {
    rewards: { program: required(program), ...(partners.length > 0 ? { partners } : {}) },
    fallback
  }
}

export const rawBonusPoints = (features: ReadonlyArray<{ readonly additionalValue?: string | null | undefined }>) =>
  Option.getOrUndefined(
    EffectArray.findFirst(
      EffectArray.map(features, (f) => parseNumber(f.additionalValue)),
      (n) => n !== undefined && n > 0
    )
  )

const perks = (p: ProductDetail): NormalisedCard["perks"] => {
  const features = p.features ?? []

  const insurance = [
    ...new Set(
      EffectArray.filter(
        EffectArray.map(
          EffectArray.filter(features, (f) => f.featureType === "INSURANCE"),
          (f) => (f.additionalValue == null ? undefined : EffectString.trim(f.additionalValue))
        ),
        (v): v is string => !(v == null || v === "") && v.length < 80
      )
    )
  ]

  const lounge = EffectArray.some(features, (f) =>
    /lounge/iu.test(`${f.additionalValue ?? ""} ${f.additionalInfo ?? ""}`)
  )

  return {
    ...(insurance.length > 0 ? { insurance } : {}),
    ...(lounge ? { lounge_access: true } : {})
  }
}

const normaliseImpl = (p: ProductDetail, ctx: NormaliseContext): NormaliseResult => {
  const fees = p.fees ?? []
  const rates = p.lendingRates ?? []
  const cash = cashAdvanceFee(fees)

  const constraint = (type: string) =>
    parseNumber(
      Option.getOrUndefined(EffectArray.findFirst(p.constraints ?? [], (c) => c.constraintType === type))
        ?.additionalValue
    )

  const minIncome = Option.getOrUndefined(
    EffectArray.findFirst(
      EffectArray.map(
        EffectArray.filter(p.eligibility ?? [], (e) => e.eligibilityType === "MIN_INCOME"),
        (e) => parseNumber(e.additionalValue)
      ),
      (n) => n !== undefined
    )
  )

  const intro = introOffers(rates)
  const { rewards: rewardsValue, fallback } = rewards(p, ctx)
  const net = network(p, ctx.brandName)
  const image = p.cardArt?.[0]?.imageUri

  const card: NormalisedCard = defined({
    name: EffectString.trim(p.name),
    type: cardType(p),
    network: net,
    status: "active" as const,
    description: pipe(
      Option.fromNullishOr(p.description),
      Option.map(EffectString.trim),
      Option.filter((d) => d !== ""),
      Option.getOrUndefined
    ),
    url: p.applicationUri ?? undefined,
    image,
    cdr: defined({ brand: ctx.brandName, product_id: p.productId, last_updated: p.lastUpdated ?? undefined }),
    fees: defined({
      annual: annualFee(fees),
      additional_card: additionalCardFee(fees),
      foreign_txn_pct: foreignTransactionFee(fees),
      cash_advance_pct: cash.pct,
      cash_advance_min: cash.min,
      late_payment: latePaymentFee(fees)
    }),
    rates: defined({
      purchase: ongoingRate(rates, "PURCHASE", /cash|balance|business secured/iu),
      cash_advance: ongoingRate(rates, "CASH_ADVANCE"),
      balance_transfer: ongoingRate(rates, "BALANCE_TRANSFER"),
      interest_free_days: interestFreeDays(p)
    }),
    limits: defined({
      min_credit: constraint("MIN_LIMIT"),
      max_credit: constraint("MAX_LIMIT"),
      min_income: minIncome
    }),
    rewards: rewardsValue,
    perks: perks(p)
  })

  const offers: CdrOfferInputs = {
    intro,
    annualFirstYear: firstYearFee(fees),
    bonusPoints:
      rewardsValue === undefined
        ? undefined
        : rawBonusPoints(EffectArray.filter(p.features ?? [], (f) => f.featureType === "BONUS_REWARDS"))
  }

  return { card, offers, fallbackProgram: fallback }
}

export const normalise = dual<
  (ctx: NormaliseContext) => (p: ProductDetail) => NormaliseResult,
  (p: ProductDetail, ctx: NormaliseContext) => NormaliseResult
>(2, normaliseImpl)
