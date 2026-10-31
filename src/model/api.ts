import { Schema } from "effect"
import type { Api } from "../build/build.ts"
import { Card, Program } from "./schema.ts"

// Decode the public API at the browser boundary instead of trusting response.json().
const PublicApi = Schema.Struct({
  programs: Schema.Record(Schema.String, Program),
  issuers: Schema.Record(
    Schema.String,
    Schema.Struct({
      name: Schema.String,
      website: Schema.optionalKey(Schema.String),
      cards: Schema.Record(Schema.String, Card)
    })
  )
})

export const decodeApi = (value: unknown): Api => Schema.decodeUnknownSync(PublicApi)(value)
