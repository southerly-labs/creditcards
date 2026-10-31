import { Option, Predicate, Result, Schema } from "effect"
import type { Api } from "../build/build.ts"
import { Card, Program } from "./schema.ts"

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

export const decodePointValues = (text: string): Record<string, number> => {
  const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(text)
  const values: Record<string, number> = {}

  if (Option.isNone(parsed) || !Predicate.isObjectOrArray(parsed.value)) return values

  for (const [id, value] of Object.entries(parsed.value)) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) values[id] = value
  }

  return values
}

export const loadPointValues = (read: () => string | null): Record<string, number> =>
  Result.match(Result.try(read), {
    onFailure: () => ({}),
    onSuccess: (text) => decodePointValues(text ?? "{}")
  })
