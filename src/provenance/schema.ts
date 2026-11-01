import { Schema } from "effect"

export const ProvenanceSection = Schema.Literals(["fees", "rates", "limits", "perks", "rewards"])

export const Provenance = Schema.Struct({
  cdr_observed_at: Schema.optionalKey(Schema.String),
  sections: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        source_urls: Schema.NonEmptyArray(Schema.String.pipe(Schema.check(Schema.isPattern(/^https?:\/\//u)))),
        reviewed_at: Schema.String,
        correction_reason: Schema.NonEmptyString
      })
    )
  )
})
