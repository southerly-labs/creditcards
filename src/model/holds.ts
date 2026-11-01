import { Schema } from "effect"
import { CalendarDate } from "./domain.ts"

export const Hold = Schema.Struct({
  id: Schema.NonEmptyString,
  card: Schema.NonEmptyString,
  change: Schema.NonEmptyString,
  kind: Schema.Literals(["approve", "confirm"]),
  reason: Schema.NonEmptyString,
  current: Schema.optionalKey(Schema.String),
  proposed: Schema.optionalKey(Schema.String),
  since: CalendarDate,
  history: Schema.optionalKey(Schema.String),
  decision: Schema.optionalKey(Schema.Literals(["approve", "reject"])),
  decided_on: Schema.optionalKey(CalendarDate),
  evidence: Schema.optionalKey(Schema.NonEmptyString)
})

export type Hold = typeof Hold.Type

export const SyncHolds = Schema.Struct({ hold: Schema.optionalKey(Schema.Array(Hold)) })
