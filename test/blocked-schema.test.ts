import { assert, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { EarnCheck } from "../src/model/schema.ts"

it.effect("accepts existing quotes and optional blocked evidence without losing the quote", () =>
  Effect.gen(function* () {
    const quote: EarnCheck = { url: "https://example.com", expect: ["1 point"] }
    assert.deepStrictEqual(yield* Schema.decodeEffect(EarnCheck)(quote), quote)
    const blocked = { ...quote, known_blocked: { reason: "Bot protection", evidence: "HTTP 403", since: "2026-11-04" } }
    assert.deepStrictEqual(yield* Schema.decodeEffect(EarnCheck)(blocked), blocked)
  })
)
