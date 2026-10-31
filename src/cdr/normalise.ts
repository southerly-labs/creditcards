import { defined } from "../util/defined.ts"
import { Schema } from "effect"
import { required } from "../util/required.ts"
import type { Card, CardType, IntroOffer, Network, Program } from "../model/schema.ts"
import type { Fee, ProductDetail } from "./schema.ts"

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] }

export type NormalisedCard = Mutable<Card>

export interface ProgramIndex {
  readonly programs: ReadonlyArray<{
    readonly id: string
    readonly program: Program
    readonly patterns: ReadonlyArray<RegExp>
  }>
}

export const makeProgramIndex = (programs: Record<string, Program>): ProgramIndex => ({
  programs: Object.entries(programs)
    .map(([id, program]) => ({ id, program, patterns: (program.aliases ?? []).map((a) => new RegExp(a, "iu")) }))
    .toSorted((a, b) => (b.program.priority ?? 0) - (a.program.priority ?? 0))
})

export interface NormaliseContext {
  readonly issuerSlug: string
  readonly brandName: string
  readonly programs: ProgramIndex
}

export interface NormaliseResult {
  readonly card: NormalisedCard

  readonly fallbackProgram: string | undefined
}

export const parseNumber = (value: string | null | undefined): number | undefined => {
  if (value == null) return undefined
  const cleaned = value.replaceAll(/[$,\s]/gu, "")

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

export const timesPerYear = (period: string | null | undefined, name: string): number | undefined => {
  const iso = period?.trim().match(/^P(\d+)([YMWD])$/iu)

  if (iso) {
    const n = Number(iso[1])

    if (n === 0) return undefined
    const periods: Record<string, number> = { Y: 1, M: 12, W: 52 }
    const perYear = periods[required(iso[2]).toUpperCase()]

    return perYear === undefined ? undefined : perYear / n
  }

  const text = `${period ?? ""} ${name}`

  if (/month/iu.test(text)) return 12

  if (/annual|year/iu.test(text)) return 1

  return undefined
}

export const isoMonths = (value: string | null | undefined): number | undefined => {
  const iso = value?.trim().match(/^P(\d+)([YM])$/iu)

  if (iso) return Number(iso[1]) * (required(iso[2]).toUpperCase() === "Y" ? 12 : 1)
  const text = value?.match(/(\d+)\s*months?/iu)

  return text ? Number(text[1]) : undefined
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
  annualised(fees.filter((f) => f.feeType === "PERIODIC" && !NOT_CARD_FEE.test(f.name ?? "")))

export const additionalCardFee = (fees: ReadonlyArray<Fee>) =>
  annualised(fees.filter((f) => f.feeType === "PERIODIC" && ADDITIONAL_CARD.test(f.name ?? "")))

const FeeDiscounts = Schema.Struct({
  discounts: Schema.optional(
    Schema.Array(Schema.Struct({ description: Schema.optional(Schema.NullOr(Schema.String)) }))
  )
})

export const firstYearFee = (fees: ReadonlyArray<Fee>): number | undefined => {
  const discounted = fees.some(
    (f) =>
      f.feeType === "PERIODIC" &&
      !NOT_CARD_FEE.test(f.name ?? "") &&
      (Schema.decodeUnknownSync(FeeDiscounts)(f).discounts ?? []).some((d) =>
        /first year free|\$0 (annual fee )?(in|for) the first year|no annual fee (in|for) the first year/iu.test(
          d.description ?? ""
        )
      )
  )

  return discounted ? 0 : undefined
}

const FX_NAME = /international|overseas|foreign|currency conversion|cross[- ]border/iu
const NOT_FX = /replacement|atm|cash|withdraw|deposit|emergency|card fee|statement|travel\/procurement/iu

export const foreignTransactionFee = (fees: ReadonlyArray<Fee>): number | undefined => {
  const candidates = fees.filter(
    (f) =>
      !["CASH_ADVANCE", "REPLACEMENT", "WITHDRAWAL", "DEPOSIT", "PERIODIC"].includes(f.feeType) &&
      !NOT_FX.test(f.name ?? "") &&
      (FX_NAME.test(f.name ?? "") || FX_NAME.test(f.additionalInfo ?? ""))
  )

  const rates = candidates
    .values()
    .map((f) => feeRate(f) ?? (fixedAmount(f) === 0 ? 0 : undefined))
    .filter((r): r is number => r !== undefined)
    .toArray()

  return rates.length > 0 ? Math.max(...rates) : undefined
}

export const cashAdvanceFee = (fees: ReadonlyArray<Fee>) => {
  const cash = fees.filter((f) => f.feeType === "CASH_ADVANCE" && !/overseas|international/iu.test(f.name ?? ""))
  const pct = cash.map((fee) => feeRate(fee)).find((r) => r !== undefined)

  const min = cash
    .map((f) => f.fixedAmount?.amount ?? f.amount)
    .map((value) => parseNumber(value))
    .find((r) => r !== undefined)

  return { pct, min }
}

export const latePaymentFee = (fees: ReadonlyArray<Fee>) =>
  fees
    .values()
    .filter((f) => f.feeType === "LATE_PAYMENT")
    .map((fee) => fixedAmount(fee))
    .find((r) => r !== undefined)

type LendingRate = NonNullable<ProductDetail["lendingRates"]>[number]

const ongoingRate = (rates: ReadonlyArray<LendingRate>, type: string, exclude?: RegExp) =>
  rates
    .values()
    .filter((r) => r.lendingRateType === type && isoMonths(r.additionalValue) === undefined)
    .filter((r) => !exclude || !exclude.test(r.additionalValue ?? ""))
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
    const text = `${r.additionalInfo ?? ""} ${r.additionalValue ?? ""}`.toLowerCase()
    const bt = r.lendingRateType === "BALANCE_TRANSFER" || text.includes("balance transfer")
    const purchase = r.lendingRateType === "PURCHASE" || text.includes("purchase")
    const applies_to = bt && purchase ? "both" : purchase ? "purchase" : "balance_transfer"
    const months = isoMonths(r.additionalValue) ?? isoMonths(r.additionalInfo)
    const offer = { applies_to, rate, ...(months !== undefined && months <= 60 ? { months } : {}) } as const

    if (!offers.some((o) => o.applies_to === offer.applies_to && o.rate === offer.rate && o.months === months)) {
      offers.push(offer)
    }
  }

  return offers
}

export const interestFreeDays = (p: ProductDetail): number | undefined => {
  for (const f of p.features ?? []) {
    if (f.featureType !== "INTEREST_FREE") continue
    const iso = f.additionalValue?.match(/^P(\d+)D$/u)

    if (iso) return Number(iso[1])

    const text = `${f.additionalValue ?? ""} ${f.additionalInfo ?? ""}`.match(
      /up to (\d+) (?:interest[- ]free )?days/iu
    )

    if (text) return Number(text[1])
  }

  return undefined
}

export const cardType = (p: ProductDetail): CardType => {
  if (/corporate|procurement|purchasing|commercial|virtual card|travel (and|&) expense/iu.test(p.name))
    return "corporate"

  const business =
    /business/iu.test(p.name) ||
    (p.eligibility ?? []).some((e) => e.eligibilityType === "BUSINESS" || e.eligibilityType === "MIN_TURNOVER")

  return business ? "business" : "personal"
}

const NETWORKS: ReadonlyArray<readonly [Network, RegExp]> = [
  ["amex", /american express|\bamex\b/iu],
  ["mastercard", /master ?card/iu],
  ["visa", /\bvisa\b/iu],
  ["unionpay", /union ?pay/iu]
]

export const network = (p: ProductDetail, brandName: string): Network | undefined => {
  if (/american express/iu.test(brandName)) return "amex"
  const fromName = NETWORKS.filter(([, re]) => re.test(p.name))

  if (fromName.length === 1) return required(fromName[0])[0]
  const text = [p.description, ...(p.features ?? []).flatMap((f) => [f.additionalValue, f.additionalInfo])].join(" ")

  const counts = NETWORKS.values()
    .map(([n, re]) => [n, (text.match(new RegExp(re, "giu")) ?? []).length] as const)
    .filter(([n, c]) => c > 0 && n !== "amex")
    .toArray()

  return counts.length === 1 ? required(counts[0])[0] : undefined
}

export const matchProgram = (index: ProgramIndex, text: string): string | undefined =>
  index.programs.find((p) => p.patterns.some((re) => re.test(text)))?.id

export const issuerProgramId = (issuerSlug: string) => `${issuerSlug}-rewards`

const rewards = (p: ProductDetail, ctx: NormaliseContext) => {
  const loyalty = (p.features ?? []).filter((f) => f.featureType === "LOYALTY_PROGRAM")

  if (loyalty.length === 0) return { rewards: undefined, fallback: undefined }
  let fallback: string | undefined
  const ids: Array<string> = []

  for (const f of loyalty) {
    const id = matchProgram(ctx.programs, f.additionalValue ?? "") ?? matchProgram(ctx.programs, f.additionalInfo ?? "")
    const resolved = id ?? (fallback = issuerProgramId(ctx.issuerSlug))

    if (!ids.includes(resolved)) ids.push(resolved)
  }

  const bonus = (p.features ?? [])
    .filter((f) => f.featureType === "BONUS_REWARDS")
    .map((f) => parseNumber(f.additionalValue))
    .find((n) => n !== undefined && n > 0)

  const [program, ...partners] = ids

  return {
    rewards: {
      program: required(program),
      ...(partners.length > 0 ? { partners } : {}),
      ...(bonus === undefined ? {} : { bonus_points: bonus })
    },
    fallback
  }
}

const perks = (p: ProductDetail): NormalisedCard["perks"] => {
  const features = p.features ?? []

  const insurance = [
    ...new Set(
      features
        .filter((f) => f.featureType === "INSURANCE")
        .map((f) => f.additionalValue?.trim())
        .filter((v): v is string => !(v == null || v === "") && v.length < 80)
    )
  ]

  const lounge = features.some((f) => /lounge/iu.test(`${f.additionalValue ?? ""} ${f.additionalInfo ?? ""}`))

  return {
    ...(insurance.length > 0 ? { insurance } : {}),
    ...(lounge ? { lounge_access: true } : {})
  }
}

export const normalise = (p: ProductDetail, ctx: NormaliseContext): NormaliseResult => {
  const fees = p.fees ?? []
  const rates = p.lendingRates ?? []
  const cash = cashAdvanceFee(fees)

  const constraint = (type: string) =>
    parseNumber((p.constraints ?? []).find((c) => c.constraintType === type)?.additionalValue)

  const minIncome = (p.eligibility ?? [])
    .filter((e) => e.eligibilityType === "MIN_INCOME")
    .map((e) => parseNumber(e.additionalValue))
    .find((n) => n !== undefined)

  const intro = introOffers(rates)
  const { rewards: rewardsValue, fallback } = rewards(p, ctx)
  const net = network(p, ctx.brandName)
  const image = p.cardArt?.[0]?.imageUri

  const card: NormalisedCard = defined({
    name: p.name.trim(),
    type: cardType(p),
    network: net,
    status: "active" as const,
    description: p.description?.trim() === "" ? undefined : p.description?.trim(),
    url: p.applicationUri ?? undefined,
    image,
    cdr: defined({ brand: ctx.brandName, product_id: p.productId, last_updated: p.lastUpdated ?? undefined }),
    fees: defined({
      annual: annualFee(fees),
      annual_first_year: firstYearFee(fees),
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
      interest_free_days: interestFreeDays(p),
      intro: intro.length > 0 ? intro : undefined
    }),
    limits: defined({
      min_credit: constraint("MIN_LIMIT"),
      max_credit: constraint("MAX_LIMIT"),
      min_income: minIncome
    }),
    rewards: rewardsValue,
    perks: perks(p)
  })

  return { card, fallbackProgram: fallback }
}
