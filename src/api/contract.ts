import { Schema } from "effect"
import { Card, creditRange, earnTierOrder, Program } from "../model/schema.ts"

const { locked: _locked, ...cardFields } = Card.fields
const { aliases: _aliases, priority: _priority, ...programFields } = Program.fields

export const PublicCard = Schema.Struct(cardFields).check(creditRange, earnTierOrder)

export type PublicCard = typeof PublicCard.Type

export const PublicProgram = Schema.Struct(programFields)

export const DatasetFreshness = Schema.Struct({
  cdr_latest_product_updated_at: Schema.optionalKey(Schema.String),
  cdr_products_with_known_updated_at: Schema.Int,
  card_count: Schema.Int
})

export const PublicApi = Schema.Struct({
  schema_version: Schema.Literal(1),
  generated_at: Schema.optionalKey(Schema.String),
  freshness: DatasetFreshness,
  programs: Schema.Record(Schema.String, PublicProgram),
  issuers: Schema.Record(
    Schema.String,
    Schema.Struct({
      name: Schema.String,
      website: Schema.optionalKey(Schema.String),
      cards: Schema.Record(Schema.String, PublicCard)
    })
  )
})

export type Api = typeof PublicApi.Type

export const decodeApi = Schema.decodeUnknownSync(PublicApi)
