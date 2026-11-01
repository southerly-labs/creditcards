import { Provenance } from "../provenance/schema.ts"
import { Schema } from "effect"
import { EarnRule } from "./earn.ts"
import { CalendarDate, Timestamp, WebUrl, orderedTiers, recognizesLock } from "./domain.ts"
import { Offer, SignupReview, uniqueOfferIds } from "../offers/schema"

const between = (minimum: number, maximum: number) =>
  Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum, maximum })))

const Aud = between(0, 100_000_000)
const Percent = between(0, 50)
const Slug = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)))

export const CardType = Schema.Literals(["personal", "business", "corporate"])

export type CardType = typeof CardType.Type

export const Network = Schema.Literals(["visa", "mastercard", "amex", "unionpay", "eftpos"])

export type Network = typeof Network.Type

export const IntroOffer = Schema.Struct({
  applies_to: Schema.Literals(["purchase", "balance_transfer", "both"]),
  rate: Percent,
  months: Schema.optionalKey(between(1, 60).check(Schema.isInt()))
})

export type IntroOffer = typeof IntroOffer.Type

export const EarnRate = Schema.Struct({
  rate: between(0, 20),
  category: Schema.optionalKey(Schema.String),
  cap_monthly: Schema.optionalKey(Aud),
  cap_annual: Schema.optionalKey(Aud),
  note: Schema.optionalKey(Schema.String)
})

export type EarnRate = typeof EarnRate.Type

export const BonusTranche = Schema.Struct({
  points: between(1, 1_000_000).check(Schema.isInt()),
  year: Schema.Literals([1, 2]),
  min_spend: Schema.optionalKey(Aud),
  spend_days: Schema.optionalKey(between(1, 730).check(Schema.isInt())),
  keep_months: Schema.optionalKey(between(1, 60).check(Schema.isInt())),
  note: Schema.optionalKey(Schema.String)
})

export type BonusTranche = typeof BonusTranche.Type

export const EarnCheck = Schema.Struct({
  url: WebUrl,
  expect: Schema.NonEmptyArray(Schema.NonEmptyString)
})

export type EarnCheck = typeof EarnCheck.Type

export const RewardsReview = Schema.Struct({
  state: Schema.Literals(["unknown", "present", "none"]),
  reviewed_at: Schema.optionalKey(CalendarDate)
})

export type RewardsReview = typeof RewardsReview.Type

const CardFields = Schema.Struct({
  name: Schema.NonEmptyString,
  type: CardType,
  network: Schema.optionalKey(Network),
  status: Schema.Literals(["active", "closed", "discontinued"]),
  first_seen: CalendarDate,
  closed: Schema.optionalKey(CalendarDate),
  discontinued: Schema.optionalKey(CalendarDate),
  description: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(WebUrl),
  image: Schema.optionalKey(WebUrl),

  provenance: Schema.optionalKey(Provenance),
  offers: Schema.optionalKey(Schema.Array(Offer)),
  signup_review: Schema.optionalKey(SignupReview),
  locked: Schema.optionalKey(Schema.Array(Schema.String)),
  cdr: Schema.optionalKey(
    Schema.Struct({
      brand: Schema.String,
      product_id: Schema.String,
      last_updated: Schema.optionalKey(Timestamp)
    })
  ),
  fees: Schema.Struct({
    annual: Schema.optionalKey(between(0, 5000)),
    additional_card: Schema.optionalKey(between(0, 1000)),
    foreign_txn_pct: Schema.optionalKey(between(0, 10)),
    cash_advance_pct: Schema.optionalKey(between(0, 10)),
    cash_advance_min: Schema.optionalKey(between(0, 100)),
    late_payment: Schema.optionalKey(between(0, 100))
  }),
  rates: Schema.Struct({
    purchase: Schema.optionalKey(Percent),
    cash_advance: Schema.optionalKey(Percent),
    balance_transfer: Schema.optionalKey(Percent),
    interest_free_days: Schema.optionalKey(between(0, 120).check(Schema.isInt()))
  }),
  limits: Schema.Struct({
    min_credit: Schema.optionalKey(Aud),
    max_credit: Schema.optionalKey(Aud),
    min_income: Schema.optionalKey(Aud)
  }),
  rewards: Schema.optionalKey(
    Schema.Struct({
      program: Slug,
      partners: Schema.optionalKey(Schema.Array(Slug)),
      earn: Schema.optionalKey(Schema.Array(EarnRate)),
      earn_rules: Schema.optionalKey(Schema.Array(EarnRule)),

      earn_review: Schema.optionalKey(RewardsReview),
      earn_source: Schema.optionalKey(Schema.Literals(["parser", "manual"])),

      earn_text_hash: Schema.optionalKey(Schema.String),
      earn_check: Schema.optionalKey(Schema.Array(EarnCheck))
    })
  ),
  perks: Schema.Struct({
    insurance: Schema.optionalKey(Schema.Array(Schema.String)),
    lounge_access: Schema.optionalKey(Schema.Boolean)
  })
})

type CardLimitsAndRewards = Pick<typeof CardFields.Type, "limits" | "rewards">

export const creditRange = Schema.makeFilter(
  (card: CardLimitsAndRewards) =>
    card.limits.min_credit === undefined ||
    card.limits.max_credit === undefined ||
    card.limits.min_credit <= card.limits.max_credit ||
    "Minimum credit exceeds maximum credit"
)

export const earnTierOrder = Schema.makeFilter(
  (card: CardLimitsAndRewards) =>
    orderedTiers(card.rewards?.earn ?? []) ||
    "Earn tier ceilings must increase within each category and period; uncapped tiers must be last"
)

export const Card = CardFields.check(
  Schema.makeFilter(
    (card) =>
      card.discontinued === undefined ||
      card.status === "discontinued" ||
      "A discontinued date needs status discontinued"
  ),
  Schema.makeFilter(
    (card) =>
      card.closed === undefined || card.status !== "active" || "A closed date needs status closed or discontinued"
  ),
  creditRange,
  earnTierOrder,
  Schema.makeFilter((card) => uniqueOfferIds(card.offers ?? []) || "Offer ids must be unique within a card"),
  Schema.makeFilter(
    (card) => (card.locked ?? []).every((path) => recognizesLock(CardFields.ast, path)) || "Unrecognized lock path"
  )
)

export type Card = typeof Card.Type

export const Issuer = Schema.Struct({
  name: Schema.NonEmptyString,
  website: Schema.optionalKey(WebUrl),

  cdr_brands: Schema.Array(Schema.String)
})

export type Issuer = typeof Issuer.Type

export const Program = Schema.Struct({
  name: Schema.NonEmptyString,
  type: Schema.Literals(["airline", "bank", "retail", "cashback"]),

  aliases: Schema.optionalKey(Schema.Array(Schema.String)),

  priority: Schema.optionalKey(Schema.Int),

  cents_per_point: Schema.optionalKey(between(0, 10)),

  value_basis: Schema.optionalKey(Schema.String),
  value_source: Schema.optionalKey(WebUrl),
  value_updated: Schema.optionalKey(CalendarDate),
  website: Schema.optionalKey(WebUrl)
})

export type Program = typeof Program.Type
