import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { Card } from "../model/schema"
import { Offer } from "./schema"
import { availableOffers, offerStatus, projectOffers } from "./project"

const offer: Offer = {
  components: [{ kind: "cash_credit", amount: 100 }],
  valid_from: "2026-01-01",
  valid_until: "2026-01-31"
}

const card = Schema.decodeUnknownSync(Card)({
  name: "Test",
  type: "personal",
  status: "active",
  fees: { annual_first_year: 0 },
  rates: { intro: [{ applies_to: "purchase", rate: 0 }] },
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
  it("projects only known legacy values without dates", () => {
    expect(projectOffers(card)).toEqual([
      { components: [{ kind: "intro_rate", applies_to: "purchase", rate: 0 }] },
      { components: [{ kind: "fee_discount", fee: "annual", payable: 0, months: 12 }] }
    ])
    expect(offerStatus(projectOffers(card)[0] ?? offer, "2026-01-01")).toBe("undated")
  })
  it("never resurrects legacy offers after explicit offers expire or are cleared", () => {
    expect(availableOffers({ ...card, offers: [offer] }, "2026-02-01")).toEqual([])
    expect(projectOffers({ ...card, offers: [] })).toEqual([])
    expect(availableOffers({ ...card, offers: [offer] }, "2025-12-31")).toEqual([])
  })
})
