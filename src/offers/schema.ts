import { Schema } from "effect"

const amount = Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100_000_000 })))
const months = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 120 })))

function validDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`)

  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export const OfferDate = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)),
  Schema.check(Schema.makeFilter(validDate))
)

export const OfferComponent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("intro_rate"),
    applies_to: Schema.Literals(["purchase", "balance_transfer", "both"]),
    rate: Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 50 }))),
    months: Schema.optionalKey(months)
  }),
  Schema.Struct({
    kind: Schema.Literal("fee_discount"),
    fee: Schema.NonEmptyString,
    payable: amount,
    months: Schema.optionalKey(months)
  }),
  Schema.Struct({
    kind: Schema.Literal("signup_points"),
    program: Schema.NonEmptyString,
    points: amount,
    year: Schema.optionalKey(Schema.Literals([1, 2])),
    min_spend: Schema.optionalKey(amount),
    spend_days: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))),
    keep_months: Schema.optionalKey(months),
    note: Schema.optionalKey(Schema.String)
  }),
  Schema.Struct({
    kind: Schema.Literal("cash_credit"),
    amount,
    conditions: Schema.optionalKey(Schema.NonEmptyString)
  })
])

export const Offer = Schema.Struct({
  components: Schema.NonEmptyArray(OfferComponent),
  valid_from: Schema.optionalKey(OfferDate),
  valid_until: Schema.optionalKey(OfferDate),
  eligibility: Schema.optionalKey(Schema.NonEmptyString),
  application_channel: Schema.optionalKey(Schema.NonEmptyString),
  conditions: Schema.optionalKey(Schema.NonEmptyString)
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (offer: { readonly valid_from?: string; readonly valid_until?: string }) =>
        offer.valid_from === undefined || offer.valid_until === undefined || offer.valid_from <= offer.valid_until
    )
  )
)

export type Offer = typeof Offer.Type
