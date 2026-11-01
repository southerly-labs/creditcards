import { Schema } from "effect"
import { Timestamp } from "../model/domain.ts"

export const ProvenanceSection = Schema.Literals(["fees", "rates", "limits", "perks", "rewards"])

export type ProvenanceSection = typeof ProvenanceSection.Type

export const sectionLocks = (section: ProvenanceSection): ReadonlyArray<string> =>
  section === "rewards" ? ["rewards.program", "rewards.partners"] : [section]

export const Provenance = Schema.Struct({
  cdr_observed_at: Schema.optionalKey(Schema.String),
  sections: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        source_urls: Schema.NonEmptyArray(Schema.String.pipe(Schema.check(Schema.isPattern(/^https?:\/\//u)))),
        observed_at: Schema.optionalKey(Schema.String),
        reviewed_at: Schema.String,
        correction_reason: Schema.NonEmptyString
      })
    )
  )
})

export const CdrObservations = Schema.Record(Schema.String, Timestamp)
