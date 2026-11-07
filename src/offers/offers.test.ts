import { assert, describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"
import { Card } from "../model/schema"
import { Offer } from "./schema"
import { offerStatus } from "./project"
import { initialLifecycle } from "../machine/cardLifecycle.ts"

const offer: Offer = {
  id: "offer-1",
  source: "manual",
  components: [{ kind: "cash_credit", amount: 100 }],
  valid_from: "2026-01-01",
  valid_until: "2026-01-31"
}

const card: Card = {
  name: "Test",
  type: "personal",
  lifecycle: initialLifecycle,
  first_seen: "2026-10-31",
  fees: {},
  rates: {},
  limits: {},
  perks: {}
}

const decodes = <S extends Schema.Top>(schema: S, input: unknown) =>
  Effect.exit(Schema.decodeUnknownEffect(schema)(input)).pipe(Effect.map(Exit.isSuccess))

describe("offers", () => {
  it("uses inclusive date boundaries without claiming eligibility", () => {
    expect(offerStatus(offer, "2025-12-31")).toBe("upcoming")
    expect(offerStatus(offer, "2026-01-01")).toBe("within_window")
    expect(offerStatus(offer, "2026-01-31")).toBe("within_window")
    expect(offerStatus(offer, "2026-02-01")).toBe("expired")
  })
  it.effect("rejects duplicate offer ids within a card", () =>
    Effect.gen(function* () {
      const signup = { id: "signup", source: "parser", components: [{ kind: "cash_credit", amount: 100 }] }

      assert.isFalse(yield* decodes(Card, { ...card, offers: [signup, signup] }))
      assert.isTrue(yield* decodes(Card, { ...card, offers: [signup, { ...signup, id: "other" }] }))
    })
  )
  it.effect("rejects invalid and reversed calendar dates", () =>
    Effect.gen(function* () {
      assert.isFalse(yield* decodes(Offer, { ...offer, valid_until: "2026-02-30" }))
      assert.isFalse(yield* decodes(Offer, { ...offer, valid_until: "2025-01-01" }))
    })
  )
})
