import { required } from "../src/util/required.ts"
import { describe, expect, test } from "@effect/vitest"
import { Schema } from "effect"
import {
  annualFee,
  cardType,
  foreignTransactionFee,
  introOffers,
  latePaymentFee,
  makeProgramIndex,
  matchProgram,
  timesPerYear,
  toPercent
} from "../src/cdr/normalise.ts"
import type { Fee, ProductDetail } from "../src/cdr/schema.ts"
import { diffCard, holdReasons, mergeCard } from "../src/sync/merge.ts"
import { cardSlug } from "../src/sync/issuers.ts"
import { Card } from "../src/model/schema.ts"

const fixed = (name: string, amount: string, period?: string): Fee => ({
  name,
  feeType: "PERIODIC",
  feeMethodUType: "fixedAmount",
  fixedAmount: { amount },
  ...(period != null && period !== "" ? { additionalValue: period } : {})
})

describe("fees", () => {
  test("annual fee sums mandatory periodic fees (ANZ style)", () => {
    expect(
      annualFee([
        fixed("Account Service", "370.00", "P1Y"),
        fixed("Rewards Program", "55.00", "P1Y"),
        fixed("Additional Cardholder Account Service", "10.00", "P1Y")
      ])
    ).toBe(425)
  })

  test("monthly fees are annualised and free-text periods are understood", () => {
    expect(annualFee([fixed("Monthly Fee", "35.00", "P1M")])).toBe(420)
    expect(annualFee([fixed("Card fee", "5", "Monthly")])).toBe(60)
    expect(annualFee([fixed("Annual fee", "40", "pay yearly")])).toBe(40)
  })

  test("optional opt-in fees are excluded", () => {
    expect(annualFee([fixed("Monthly Fee", "6", "P1M"), fixed("Qantas Frequent Flyer Direct fee", "60", "P1Y")])).toBe(
      72
    )
  })

  test("FX fee picks rate-based international fees and ignores replacement cards", () => {
    const fees: Array<Fee> = [
      { name: "Replacement card fee (overseas)", feeType: "REPLACEMENT", fixedAmount: { amount: "175" } },
      { name: "International Transaction Fee", feeType: "TRANSACTION", rateBased: { rate: "0.03" } }
    ]

    expect(foreignTransactionFee(fees)).toBe(3)
  })

  test("FX fee of fixed $0 means no FX fee", () => {
    expect(
      foreignTransactionFee([
        { name: "Foreign Transaction Fee", feeType: "TRANSACTION", fixedAmount: { amount: "0.00" } }
      ])
    ).toBe(0)
  })
})

describe("late payment fee", () => {
  const event = (name: string, amount: string): Fee => ({ name, feeType: "EVENT", fixedAmount: { amount } })

  test("reads the LATE_PAYMENT fee type", () => {
    expect(latePaymentFee([{ name: "Late fee", feeType: "LATE_PAYMENT", fixedAmount: { amount: "20.00" } }])).toBe(20)
  })

  test("reads late fees published as events, including coded names", () => {
    expect(latePaymentFee([event("Late Payment Fee", "30.00")])).toBe(30)
    expect(latePaymentFee([event("LATE_PAYMENT_FEE_-_QANTAS_CREDIT_CARD", "15.00")])).toBe(15)
    expect(latePaymentFee([event("FEELATEPAY", "20.00")])).toBe(20)
    expect(latePaymentFee([event("LATE/MISSED_PAYMENT", "8.00")])).toBe(8)
    expect(latePaymentFee([event("Missed payment fee", "25.00")])).toBe(25)
  })

  test("ignores other event fees, reminder fees and late fees with no fixed amount", () => {
    expect(latePaymentFee([event("FEECARDREP", "10.00"), event("Late Payment Reminder Fee", "40.00")])).toBeUndefined()
    expect(
      latePaymentFee([{ name: "Late Payment Fee", feeType: "EVENT", additionalInfo: "3% or $20" }])
    ).toBeUndefined()
  })
})

describe("rates", () => {
  test("decimal and percent rates both normalise to percent", () => {
    expect(toPercent("0.2099")).toBe(20.99)
    expect(toPercent("20.99")).toBe(20.99)
  })

  test("periods", () => {
    expect(timesPerYear("P1Y", "")).toBe(1)
    expect(timesPerYear("P1M", "")).toBe(12)
    expect(timesPerYear("P0D", "")).toBeUndefined()
  })

  test("intro offers detect what they apply to", () => {
    expect(
      introOffers([
        {
          lendingRateType: "INTRODUCTORY",
          rate: "0",
          additionalValue: "P24M",
          additionalInfo: "0% p.a. for 24 months on balance transfers"
        },
        {
          lendingRateType: "INTRODUCTORY",
          rate: "0",
          additionalValue: "P6M",
          additionalInfo: "0% p.a. for 6 months on purchases"
        }
      ])
    ).toEqual([
      { applies_to: "balance_transfer", rate: 0, months: 24 },
      { applies_to: "purchase", rate: 0, months: 6 }
    ])
  })
})

describe("classification", () => {
  const product = (name: string, eligibility: ProductDetail["eligibility"] = []): ProductDetail => ({
    productId: "x",
    name,
    productCategory: "CRED_AND_CHRG_CARDS",
    eligibility
  })

  test("card type", () => {
    expect(cardType(product("Low Rate credit card"))).toBe("personal")
    expect(cardType(product("Business Platinum credit card"))).toBe("business")
    expect(cardType(product("Rewards card", [{ eligibilityType: "BUSINESS" }]))).toBe("business")
    expect(cardType(product("Corporate charge card"))).toBe("corporate")
  })

  test("program matching prefers airline programs", () => {
    const index = makeProgramIndex({
      qantas: { name: "Qantas", type: "airline", aliases: ["qantas"], priority: 10 },
      amplify: { name: "Amplify", type: "bank", aliases: ["amplify"] }
    })

    expect(matchProgram(index, "Amplify Signature Qantas")).toBe("qantas")
    expect(matchProgram(index, "Amplify Rewards")).toBe("amplify")
    expect(matchProgram(index, "Heritage Credits")).toBeUndefined()
  })

  test("card slugs drop the issuer name", () => {
    expect(cardSlug("ANZ Frequent Flyer Black", "ANZ")).toBe("frequent-flyer-black")
    expect(cardSlug("American Express® Platinum Card", "American Express")).toBe("platinum-card")
    expect(cardSlug("The Qantas American Express Ultimate Card", "American Express")).toBe(
      "qantas-american-express-ultimate-card"
    )
  })
})

describe("merge and guardrails", () => {
  const existing: Card = {
    name: "Card",
    type: "personal",
    status: "active",
    first_seen: "2026-10-31",
    locked: ["fees.foreign_txn_pct"],
    fees: { annual: 100, foreign_txn_pct: 0 },
    rates: { purchase: 20 },
    limits: {},
    rewards: { program: "qantas", earn: [{ rate: 1 }] },
    perks: {}
  }

  test("CDR-owned fields update, locked and curated fields survive", () => {
    const merged = Schema.decodeUnknownSync(Card)(
      mergeCard(existing, {
        name: "Card",
        type: "personal",
        status: "active",
        fees: { annual: 120, foreign_txn_pct: 3 },
        rates: { purchase: 21 },
        limits: {},
        rewards: { program: "qantas" },
        perks: {}
      })
    )

    expect(merged.fees).toEqual({ annual: 120, foreign_txn_pct: 0 })
    expect(merged.rewards?.earn).toEqual([{ rate: 1 }])
  })

  test("a cdr.last_updated bump alone is not a change", () => {
    const card: Card = { ...existing, cdr: { brand: "B", product_id: "p", last_updated: "2026-10-30" } }
    const cdr = required(card.cdr)
    const bumped = { ...card, cdr: { ...cdr, last_updated: "2026-10-31" } }
    expect(diffCard(card, bumped)).toEqual([])
    expect(diffCard(card, { ...bumped, fees: { annual: 120 } }).map((c) => c.path)).toEqual([
      "fees.annual",
      "fees.foreign_txn_pct"
    ])
  })

  test("implausible changes are held", () => {
    expect(holdReasons([{ path: "fees.annual", before: 100, after: 1000 }])).toHaveLength(1)
    expect(holdReasons([{ path: "fees.annual", before: 100, after: 120 }])).toHaveLength(0)
    expect(holdReasons([{ path: "rates.purchase", before: 20, after: 9 }])).toHaveLength(1)
    expect(holdReasons([{ path: "rates.purchase", before: 20, after: undefined }])).toHaveLength(1)
    expect(holdReasons([{ path: "rewards.earn", before: [{ rate: 1 }], after: [{ rate: 3 }] }])).toHaveLength(1)
    expect(holdReasons([{ path: "rewards.earn", before: [{ rate: 1 }], after: [{ rate: 1.5 }] }])).toHaveLength(0)
  })
})
