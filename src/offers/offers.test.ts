import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { Card } from "../model/schema"
import { Offer } from "./schema"
import { offerStatus } from "./project"

const offer: Offer = {
  id: "offer-1",
  source: "manual",
  components: [{ kind: "cash_credit", amount: 100 }],
  valid_from: "2026-01-01",
  valid_until: "2026-01-31"
}

const card = Schema.decodeUnknownSync(Card)({
  name: "Test",
  type: "personal",
  status: "active",
  first_seen: "2026-10-31",
  fees: {},
  rates: {},
  limits: {},
  perks: {}
})

describe("offers", () => {
  it("uses inclusive date boundaries without claiming eligibility", () => {
    expect(offerStatus(offer, "2025-12-31")).toBe("upcoming")
    expect(offerStatus(offer, "2026-01-01")).toBe("within_window")
    expect(offerStatus(offer, "2026-01-31")).toBe("within_window")
    expect(offerStatus(offer, "2026-02-01")).toBe("expired")
  })
  it("rejects duplicate offer ids within a card", () => {
    const signup = { id: "signup", source: "parser", components: [{ kind: "cash_credit", amount: 100 }] }

    expect(() => Schema.decodeUnknownSync(Card)({ ...card, offers: [signup, signup] })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Card)({ ...card, offers: [signup, { ...signup, id: "other" }] })
    ).not.toThrow()
  })
  it("rejects invalid and reversed calendar dates", () => {
    expect(() => Schema.decodeUnknownSync(Offer)({ ...offer, valid_until: "2026-02-30" })).toThrow()
    expect(() => Schema.decodeUnknownSync(Offer)({ ...offer, valid_until: "2025-01-01" })).toThrow()
  })
})
