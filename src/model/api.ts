import {
  DateTime,
  Effect,
  Option,
  Predicate,
  Result,
  Schema,
  String as EffectString,
  Record as EffectRecord
} from "effect"
import { HttpClient } from "effect/http"
import { PublicApi } from "../api/contract.ts"

export { decodeApi } from "../api/contract.ts"

export const fetchApi = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(Schema.decodeUnknownEffect(PublicApi))
  )

export const todayInSydney = (): string =>
  DateTime.formatIsoDate(DateTime.setZoneNamedUnsafe(DateTime.nowUnsafe(), "Australia/Sydney"))

export const decodePointValues = (text: string): Record<string, number> => {
  const parsed = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown))(text)
  const values: Record<string, number> = {}

  if (Option.isNone(parsed) || !Predicate.isObject(parsed.value)) return values

  for (const [id, value] of EffectRecord.toEntries(parsed.value)) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) values[id] = value
  }

  return values
}

export const loadPointValues = (read: () => string | null): Record<string, number> =>
  Result.match(Result.try(read), {
    onFailure: () => ({}),
    onSuccess: (text) => decodePointValues(text ?? "{}")
  })

export const decodeColumnVisibility = (text: string): Record<string, boolean> => {
  const parsed = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown))(text)
  const values: Record<string, boolean> = {}

  if (Option.isNone(parsed) || !Predicate.isObject(parsed.value)) return values

  for (const [id, value] of EffectRecord.toEntries(parsed.value)) {
    if (typeof value === "boolean") values[id] = value
  }

  return values
}

export const loadColumnVisibility = (read: () => string | null): Record<string, boolean> =>
  Result.match(Result.try(read), {
    onFailure: () => ({}),
    onSuccess: (text) => decodeColumnVisibility(text ?? "{}")
  })

export const decodeMonthlySpend = (text: string | null): number | undefined => {
  if (text === null || EffectString.trim(text) === "") return undefined
  const value = Number(text)

  return Number.isFinite(value) && value >= 0 ? value : undefined
}

export const loadMonthlySpend = (read: () => string | null): number | undefined =>
  Result.match(Result.try(read), {
    onFailure: () => undefined,
    onSuccess: decodeMonthlySpend
  })

export const attempt = (write: () => void): boolean => Result.isSuccess(Result.try(write))
