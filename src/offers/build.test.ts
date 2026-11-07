import { describe, expect, it } from "@effect/vitest"
import { Array as EffectArray, Option } from "effect"
import { Card } from "../model/schema"
import type { Offer } from "./schema"
import { applyOffers, cdrOffers, combineOffers, signupOffer, signupState } from "./build"
import { initialLifecycle } from "../machine/cardLifecycle.ts"
import { SourceReview, unread } from "../machine/review.ts"

const tranches = [
  { points: 100_000, year: 1 as const, min_spend: 6000, spend_days: 90 },
  { points: 50_000, year: 2 as const, keep_months: 15 }
]

describe("building offers", () => {
  it("gives CDR intro rates and the first-year fee stable ids", () => {
    expect(
      EffectArray.map(
        cdrOffers({
          intro: [
            { applies_to: "balance_transfer", rate: 0, months: 24 },
            { applies_to: "balance_transfer", rate: 1.99, months: 12 },
            { applies_to: "purchase", rate: 0 }
          ],
          annualFirstYear: 0
        }),
        (offer) => [offer.id, offer.source]
      )
    ).toEqual([
      ["intro-balance-transfer", "cdr"],
      ["intro-balance-transfer-2", "cdr"],
      ["intro-purchase", "cdr"],
      ["first-year-fee", "cdr"]
    ])
  })

  it("prefers parsed tranches over the raw CDR total", () => {
    const offer = signupOffer({ program: "qantas", tranches, rawTotal: 150_000, noOffer: false })

    expect(offer?.source).toBe("parser")
    expect(offer?.components).toEqual([
      { kind: "signup_points", program: "qantas", points: 100_000, year: 1, min_spend: 6000, spend_days: 90 },
      { kind: "signup_points", program: "qantas", points: 50_000, year: 2, keep_months: 15 }
    ])
  })

  it("falls back to the raw total with no year when nothing is parsed", () => {
    expect(signupOffer({ program: "qantas", tranches: undefined, rawTotal: 150_000, noOffer: false })).toEqual({
      id: "signup",
      source: "cdr",
      components: [{ kind: "signup_points", program: "qantas", points: 150_000 }]
    })
    expect(signupOffer({ program: "qantas", tranches: [], rawTotal: undefined, noOffer: false })).toBeUndefined()
  })

  it("writes no signup offer once a review says there is none", () => {
    expect(signupOffer({ program: "qantas", tranches, rawTotal: 150_000, noOffer: true })).toBeUndefined()
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

  it("leaves everything alone when offers are locked", () => {
    expect(combineOffers({ existing: [cashback], generated: [intro, signup], locked: true })).toEqual([cashback])
  })
})

describe("applying offers to a card", () => {
  const card: Card = {
    name: "Card",
    type: "personal",
    lifecycle: initialLifecycle,
    first_seen: "2026-10-31",
    fees: {},
    rates: {},
    limits: {},
    perks: {},
    rewards: { program: "qantas" }
  }

  const cdr = {
    intro: [{ applies_to: "purchase" as const, rate: 0, months: 12 }],
    annualFirstYear: 0,
    bonusPoints: 170_000
  }

  const nothingReviewed = { state: unread, parsed: undefined }

  const signupOf = (applied: Card) =>
    Option.getOrUndefined(EffectArray.findFirst(applied.offers ?? [], (offer) => offer.id === "signup"))

  it("writes CDR offers and the raw total when nothing has been reviewed", () => {
    const applied = applyOffers(card, cdr, nothingReviewed)

    expect(EffectArray.map(applied.offers ?? [], (offer) => [offer.id, offer.source])).toEqual([
      ["intro-purchase", "cdr"],
      ["first-year-fee", "cdr"],
      ["signup", "cdr"]
    ])
  })

  it("writes no signup offer after a manual no-bonus review", () => {
    const state = SourceReview.cases.Reviewed.make({ hash: "abc", outcome: "none" })
    const applied = applyOffers(card, cdr, { state, parsed: undefined })

    expect(signupOf(applied)).toBeUndefined()
  })

  it("keeps a manual signup offer over the raw total", () => {
    const manual: Offer = {
      id: "signup",
      source: "manual",
      components: [{ kind: "signup_points", program: "qantas", points: 90_000, year: 1 }]
    }

    const state = SourceReview.cases.Reviewed.make({ hash: "abc", outcome: "present" })

    expect(signupOf(applyOffers({ ...card, offers: [manual] }, cdr, { state, parsed: undefined }))).toEqual(manual)
  })

  it("round-trips parsed tranches through the stored parser offer", () => {
    const parsed = [{ points: 80_000, year: 1 as const, min_spend: 3000, spend_days: 90 }]
    const state = SourceReview.cases.Parsed.make({ hash: "abc" })
    const applied = applyOffers({ ...card, signup_state: state }, cdr, { state, parsed })

    expect(signupState(applied)).toEqual({ state, parsed })
    expect(applyOffers(applied, cdr, signupState(applied))).toEqual(applied)
  })
})
