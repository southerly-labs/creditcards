import { Schema } from "effect"

// Lenient decoders for CDR banking product reference data. Data holders vary a
// lot in how strictly they follow the standard, so almost everything beyond the
// identifiers is optional and nullable.

const OptString = Schema.optional(Schema.NullOr(Schema.String))

export class DataHolderBrand extends Schema.Class<DataHolderBrand>("cdr/DataHolderBrand")({
  dataHolderBrandId: OptString,
  interimId: OptString,
  brandName: Schema.String,
  industries: Schema.Array(Schema.String),
  publicBaseUri: Schema.String,
  logoUri: OptString,
  abn: OptString,
  lastUpdated: OptString
}) {}

export const RegisterResponse = Schema.Struct({
  data: Schema.Array(DataHolderBrand)
})

export const ProductSummary = Schema.Struct({
  productId: Schema.String,
  name: Schema.String,
  productCategory: Schema.String,
  lastUpdated: OptString,
  isTailored: Schema.optional(Schema.NullOr(Schema.Boolean))
})
export type ProductSummary = typeof ProductSummary.Type

export const ProductsPage = Schema.Struct({
  data: Schema.Struct({ products: Schema.Array(ProductSummary) }),
  links: Schema.optional(Schema.Struct({ next: OptString }))
})

export const Fee = Schema.Struct({
  name: OptString,
  feeType: Schema.String,
  // Pre-v7 shape: amount/rate fields at the top level
  amount: OptString,
  balanceRate: OptString,
  transactionRate: OptString,
  accruedRate: OptString,
  // v7+ shape: discriminated by feeMethodUType
  feeMethodUType: OptString,
  fixedAmount: Schema.optional(Schema.NullOr(Schema.Struct({ amount: OptString }))),
  rateBased: Schema.optional(Schema.NullOr(Schema.Struct({ rateType: OptString, rate: OptString }))),
  currency: OptString,
  additionalValue: OptString,
  additionalInfo: OptString
})
export type Fee = typeof Fee.Type

export const LendingRate = Schema.Struct({
  lendingRateType: Schema.String,
  rate: Schema.String,
  additionalValue: OptString,
  additionalInfo: OptString
})

export const Feature = Schema.Struct({
  featureType: Schema.String,
  additionalValue: OptString,
  additionalInfo: OptString
})

export const Eligibility = Schema.Struct({
  eligibilityType: Schema.String,
  additionalValue: OptString,
  additionalInfo: OptString
})

export const Constraint = Schema.Struct({
  constraintType: Schema.String,
  additionalValue: OptString
})

export const ProductDetail = Schema.Struct({
  productId: Schema.String,
  name: Schema.String,
  productCategory: Schema.String,
  brandName: OptString,
  description: OptString,
  lastUpdated: OptString,
  applicationUri: OptString,
  cardArt: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({ imageUri: Schema.String })))),
  fees: Schema.optional(Schema.NullOr(Schema.Array(Fee))),
  lendingRates: Schema.optional(Schema.NullOr(Schema.Array(LendingRate))),
  features: Schema.optional(Schema.NullOr(Schema.Array(Feature))),
  eligibility: Schema.optional(Schema.NullOr(Schema.Array(Eligibility))),
  constraints: Schema.optional(Schema.NullOr(Schema.Array(Constraint)))
})
export type ProductDetail = typeof ProductDetail.Type
