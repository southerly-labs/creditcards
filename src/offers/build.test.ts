import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { Card } from "../model/schema"
import { required } from "../util/required"
import type { Offer } from "./schema"
import { cdrOffers, combineOffers, signupOffer, withOffers } from "./build"

const tranches = [
  { points: 100_000, year: 1 as const, min_spend: 6000, spend_days: 90 },
  { points: 50_000, year: 2 as const, keep_months: 15 }
]

describe("building offers", () => {
  it("gives CDR intro rates and the first-year fee stable ids", () => {
    expect(
      cdrOffers({
        intro: [
          { applies_to: "balance_transfer", rate: 0, months: 24 },
          { applies_to: "balance_transfer", rate: 1.99, months: 12 },
          { applies_to: "purchase", rate: 0 }
        ],
        annualFirstYear: 0
      }).map((offer) => [offer.id, offer.source])
    ).toEqual([
      ["intro-balance-transfer", "cdr"],
      ["intro-balance-transfer-2", "cdr"],
      ["intro-purchase", "cdr"],
      ["first-year-fee", "cdr"]
    ])
  })

  it("prefers parsed tranches over the raw CDR total", () => {
    const offer = signupOffer({ program: "qantas", tranches, rawTotal: 150_000, review: undefined })

    expect(offer?.source).toBe("parser")
    expect(offer?.components).toEqual([
      { kind: "signup_points", program: "qantas", points: 100_000, year: 1, min_spend: 6000, spend_days: 90 },
      { kind: "signup_points", program: "qantas", points: 50_000, year: 2, keep_months: 15 }
    ])
  })

  it("falls back to the raw total with no year when nothing is parsed", () => {
    expect(signupOffer({ program: "qantas", tranches: undefined, rawTotal: 150_000, review: undefined })).toEqual({
      id: "signup",
      source: "cdr",
      components: [{ kind: "signup_points", program: "qantas", points: 150_000 }]
    })
    expect(signupOffer({ program: "qantas", tranches: [], rawTotal: undefined, review: undefined })).toBeUndefined()
  })

  it("writes no signup offer once a review says there is none", () => {
    expect(signupOffer({ program: "qantas", tranches, rawTotal: 150_000, review: { state: "none" } })).toBeUndefined()
  })
})

describe("combining offers", () => {
  const intro: Offer = {
    id: "intro-purchase",
    source: "cdr",
    components: [{ kind: "intro_rate", applies_to: "purchase", rate: 0 }]
  }

  const signup: Offer = {
    id: "signup",
    source: "cdr",
    components: [{ kind: "signup_points", program: "qantas", points: 150_000 }]
  }

  const manualSignup: Offer = {
    id: "signup",
    source: "manual",
    components: [{ kind: "signup_points", program: "qantas", points: 120_000, year: 1 }]
  }

  const cashback: Offer = { id: "cashback", source: "manual", components: [{ kind: "cash_credit", amount: 200 }] }

  it("replaces generated offers and drops stale ones", () => {
    const stale: Offer = { ...intro, id: "intro-both" }

    expect(combineOffers({ existing: [stale], generated: [intro, signup], locked: false })).toEqual([intro, signup])
  })

  it("lets a manual offer override a generated one with the same id, in place", () => {
    expect(combineOffers({ existing: [manualSignup, cashback], generated: [intro, signup], locked: false })).toEqual([
      intro,
      manualSignup,
      cashback
    ])
  })

  it("keeps offers without a source, since a person wrote them", () => {
    const legacy: Offer = { components: [{ kind: "cash_credit", amount: 100 }] }

    expect(combineOffers({ existing: [legacy], generated: [intro], locked: false })).toEqual([intro, legacy])
  })

  it("leaves everything alone when offers are locked", () => {
    expect(combineOffers({ existing: [cashback], generated: [intro, signup], locked: true })).toEqual([cashback])
  })
})

describe("deriving offers from legacy card fields", () => {
  const card = Schema.decodeUnknownSync(Card)({
    name: "Card",
    type: "personal",
    status: "active",
    fees: { annual_first_year: 0 },
    rates: { intro: [{ applies_to: "purchase", rate: 0, months: 12 }] },
    limits: {},
    perks: {},
    rewards: { program: "qantas", bonus_points: 170_000 }
  })

  const rewards = required(card.rewards)
  const signupOf = (derived: Card) => derived.offers?.find((offer) => offer.id === "signup")

  it("writes CDR offers and the raw total when nothing has been reviewed", () => {
    const derived = withOffers(card)

    expect(derived.offers?.map((offer) => [offer.id, offer.source])).toEqual([
      ["intro-purchase", "cdr"],
      ["first-year-fee", "cdr"],
      ["signup", "cdr"]
    ])
    expect(derived.signup_review).toBeUndefined()
  })

  it("records a manual no-bonus review and writes no signup offer", () => {
    const derived = withOffers({
      ...card,
      rewards: { ...rewards, bonus: [], bonus_source: "manual", bonus_text_hash: "abc" }
    })

    expect(derived.signup_review).toEqual({ state: "none", source: "manual", text_hash: "abc" })
    expect(signupOf(derived)).toBeUndefined()
  })

  it("follows a re-stamped manual bonus rather than the previously written offer", () => {
    const manual = { ...rewards, bonus: [{ points: 90_000, year: 1 as const }], bonus_source: "manual" as const }
    const first = withOffers({ ...card, rewards: manual })
    const second = withOffers({ ...first, rewards: { ...manual, bonus: [{ points: 60_000, year: 1 as const }] } })

    expect(signupOf(first)?.source).toBe("manual")
    expect(signupOf(second)?.components).toEqual([
      { kind: "signup_points", program: "qantas", points: 60_000, year: 1 }
    ])
  })

  it("is stable when applied twice", () => {
    const once = withOffers(card)

    expect(withOffers(once)).toEqual(once)
  })
})
