import { Schema } from "effect"

// Canonical data model. These schemas define the TOML files under data/ and
// the published API. Percentages are stored as percent (20.99 = 20.99% p.a.),
// money as AUD.

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
  months: Schema.optionalKey(between(1, 60))
})

export type IntroOffer = typeof IntroOffer.Type

// Points per AUD spent. Entries without a category are the base earn rate,
// listed as cumulative spend tiers: each applies until its cap_monthly
// (statement-period spend), then the next entry applies. If the last tier
// has a cap, spend above it earns nothing. Entries with a category override
// the base rate for that kind of spend.
export const EarnRate = Schema.Struct({
  rate: between(0, 20),
  category: Schema.optionalKey(Schema.String),
  cap_monthly: Schema.optionalKey(Aud),
  cap_annual: Schema.optionalKey(Aud),
  note: Schema.optionalKey(Schema.String)
})

export type EarnRate = typeof EarnRate.Type

// An issuer page (HTML or PDF) that states a card's earn rates, with short
// quotes copied from it. A daily check flags the card for review when a
// quote no longer appears, so manual earn rates notice issuer changes that
// the CDR text does not carry. Matching ignores case and whitespace.
export const EarnCheck = Schema.Struct({
  url: Schema.String.pipe(Schema.check(Schema.isPattern(/^https:\/\//u))),
  expect: Schema.NonEmptyArray(Schema.NonEmptyString)
})

export type EarnCheck = typeof EarnCheck.Type

export const Card = Schema.Struct({
  name: Schema.NonEmptyString,
  type: CardType,
  network: Schema.optionalKey(Network),
  status: Schema.Literals(["active", "discontinued"]),
  discontinued: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  image: Schema.optionalKey(Schema.String),
  // Dotted field paths the automated sync must not overwrite.
  locked: Schema.optionalKey(Schema.Array(Schema.String)),
  cdr: Schema.optionalKey(
    Schema.Struct({
      brand: Schema.String,
      product_id: Schema.String,
      last_updated: Schema.optionalKey(Schema.String)
    })
  ),
  fees: Schema.Struct({
    annual: Schema.optionalKey(between(0, 5000)),
    annual_first_year: Schema.optionalKey(between(0, 5000)),
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
    interest_free_days: Schema.optionalKey(between(0, 120)),
    intro: Schema.optionalKey(Schema.Array(IntroOffer))
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
      // Who wrote `earn`: the rule-based parser, or a person (never overwritten).
      earn_source: Schema.optionalKey(Schema.Literals(["parser", "manual"])),
      // Hash of the CDR loyalty text `earn` was derived from, to detect changes.
      earn_text_hash: Schema.optionalKey(Schema.String),
      earn_check: Schema.optionalKey(Schema.Array(EarnCheck)),
      bonus_points: Schema.optionalKey(between(0, 1_000_000))
    })
  ),
  perks: Schema.Struct({
    insurance: Schema.optionalKey(Schema.Array(Schema.String)),
    lounge_access: Schema.optionalKey(Schema.Boolean)
  })
})

export type Card = typeof Card.Type

export const Issuer = Schema.Struct({
  name: Schema.NonEmptyString,
  website: Schema.optionalKey(Schema.String),
  // CDR Register brand names whose products belong to this issuer.
  cdr_brands: Schema.Array(Schema.String)
})

export type Issuer = typeof Issuer.Type

export const Program = Schema.Struct({
  name: Schema.NonEmptyString,
  type: Schema.Literals(["airline", "bank", "retail", "cashback"]),
  // Case-insensitive regexes matched against CDR loyalty program text.
  aliases: Schema.optionalKey(Schema.Array(Schema.String)),
  // Matching precedence when several programs match the same text.
  priority: Schema.optionalKey(Schema.Int),
  // Estimated value of one point, in cents. Curated by hand: airline programs
  // use a flight-redemption benchmark, bank programs the airline value divided
  // by their transfer ratio, retail/cashback programs their cash value.
  cents_per_point: Schema.optionalKey(between(0, 10)),
  // How cents_per_point was worked out, where from, and when (YYYY-MM-DD).
  value_basis: Schema.optionalKey(Schema.String),
  value_source: Schema.optionalKey(Schema.String),
  value_updated: Schema.optionalKey(Schema.String),
  website: Schema.optionalKey(Schema.String)
})

export type Program = typeof Program.Type
