import { Effect, Schema } from "effect"

export const encodeJson = (value: unknown, space?: number) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, space === undefined ? {} : { space }))(value).pipe(
    Effect.orDie
  )

export const jsonEqual = (a: unknown, b: unknown): Effect.Effect<boolean> =>
  a === undefined || b === undefined
    ? Effect.succeed(a === b)
    : Effect.zipWith(encodeJson(a), encodeJson(b), (x, y) => x === y)
