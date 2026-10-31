import { Schema } from "effect"

export const encodeJson = (value: unknown, space?: number): string =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, space === undefined ? {} : { space }))(value)
