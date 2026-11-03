import { Effect, Schema } from "effect"
import { dual } from "effect/Function"

const encodeWith = (options: { readonly space?: number }) => (value: unknown) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, options))(value).pipe(Effect.orDie)

export const encodeJson = encodeWith({})

export const encodePrettyJson = encodeWith({ space: 2 })

export const jsonEqual = dual<
  (b: unknown) => (a: unknown) => Effect.Effect<boolean>,
  (a: unknown, b: unknown) => Effect.Effect<boolean>
>(2, (a: unknown, b: unknown): Effect.Effect<boolean> =>
  a === undefined || b === undefined
    ? Effect.succeed(a === b)
    : Effect.zipWith(encodeJson(a), encodeJson(b), (x, y) => x === y)
)
