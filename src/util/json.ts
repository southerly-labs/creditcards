import { Schema } from "effect"

// Diagnostic reports contain heterogeneous, already typed values. Preserve the
// JSON wire format while keeping serialization at a Schema-owned boundary.
export const encodeJson = (value: unknown, space?: number): string =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, space === undefined ? {} : { space }))(value)
