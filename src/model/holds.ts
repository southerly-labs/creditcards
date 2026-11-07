import { Schema } from "effect"
import { HoldState } from "../machine/hold.ts"
import { CalendarDate } from "./domain.ts"

export const Hold = Schema.Struct({
  id: Schema.NonEmptyString,
  card: Schema.NonEmptyString,
  change: Schema.NonEmptyString,
  reason: Schema.NonEmptyString,
  current: Schema.optionalKey(Schema.String),
  proposed: Schema.optionalKey(Schema.String),
  since: CalendarDate,
  history: Schema.optionalKey(Schema.String),
  cdr_evidence: Schema.optionalKey(Schema.NonEmptyString),
  state: HoldState
})

export type Hold = typeof Hold.Type

export const SyncHolds = Schema.Struct({ hold: Schema.optionalKey(Schema.Array(Hold)) })
