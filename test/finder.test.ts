import { assert, describe, test } from "@effect/vitest"
import { attempt } from "../src/model/api.ts"
import { entriesFrom, rank, value, type Entry, type PublicCard, type Ranked } from "../web/finder/model.ts"

const today = "2026-11-01"

const base: PublicCard = {
  name: "Card",
  type: "personal",
  status: "active",
  first_seen: "2026-10-31",
  fees: {},
  rates: {},
  limits: {},
  perks: {}
}

const entry = (id: string, card: Partial<PublicCard>, cents?: number): Entry => ({
  id,
  issuerId: "bank",
  issuer: "Bank",
  card: { ...base, name: id, ...card },
  program:
    card.rewards === undefined
      ? undefined
      : {
          id: card.rewards.program,
          name: "Points",
          type: "airline",
          ...(cents === undefined ? {} : { cents_per_point: cents })
        }
})

const valued = (e: Entry, spend = 2000, overrides: Record<string, number> = {}): Ranked => ({
  entry: e,
  valuation: value(e, spend, overrides, today)
})

describe("card finder valuation", () => {
  test("points earned on monthly spend, valued per point, less the annual fee", () => {
    const v = valued(
      entry("rewards", { fees: { annual: 300 }, rewards: { program: "qff", earn: [{ rate: 1 }] } }, 1)
    ).valuation

    assert.strictEqual(v.yearlyPoints, 24_000)
    assert.strictEqual(v.earnValue, 240)
    assert.strictEqual(v.ongoing, -60)
  })

  test("a card without rewards is worth minus its fee", () => {
    assert.strictEqual(valued(entry("plain", { fees: { annual: 55 } })).valuation.ongoing, -55)
  })

  test("unknown earn rates stay unknown instead of counting as zero", () => {
    const v = valued(entry("mystery", { fees: { annual: 0 }, rewards: { program: "qff" } }, 1)).valuation

    assert.strictEqual(v.ongoing, undefined)
  })

  test("your own point value overrides the program default", () => {
    const e = entry("rewards", { fees: { annual: 0 }, rewards: { program: "qff", earn: [{ rate: 1 }] } }, 1)

    assert.strictEqual(valued(e, 1000, { qff: 2 }).valuation.ongoing, 240)
  })

  test("year one counts first-year bonus tranches and the discounted fee", () => {
    const e = entry(
      "bonus",
      {
        fees: { annual: 400 },
        rewards: { program: "qff", earn: [{ rate: 1 }] },
        offers: [
          {
            id: "offer-1",
            source: "manual",
            components: [{ kind: "fee_discount", fee: "annual", payable: 0, months: 12 }]
          },
          {
            id: "offer-2",
            source: "manual",
            components: [
              { kind: "signup_points", program: "qff", points: 80_000, year: 1, min_spend: 3000 },
              { kind: "signup_points", program: "qff", points: 20_000, year: 2 }
            ]
          }
        ]
      },
      1
    )

    const v = valued(e).valuation

    assert.strictEqual(v.bonusPoints, 100_000)
    assert.strictEqual(v.firstYearBonusPoints, 80_000)
    assert.strictEqual(v.firstYearFee, 0)
    assert.strictEqual(v.firstYear, 240 + 800)
  })

  test("a bonus whose spend target the monthly spend misses is not counted", () => {
    const e = entry(
      "target",
      {
        fees: { annual: 0 },
        rewards: { program: "qff", earn: [{ rate: 1 }] },
        offers: [
          {
            id: "offer-3",
            source: "manual",
            components: [{ kind: "signup_points", program: "qff", points: 50_000, min_spend: 6000, spend_days: 90 }]
          }
        ]
      },
      1
    )

    const low = valued(e, 1000).valuation
    const high = valued(e, 3000).valuation

    assert.strictEqual(low.bonusMissed, true)
    assert.strictEqual(low.firstYear, 120)
    assert.strictEqual(high.bonusMissed, false)
    assert.strictEqual(high.firstYear, 360 + 500)
  })

  test("an unverified CDR signup total counts towards bonus points but not year one", () => {
    const e = entry(
      "raw",
      {
        fees: { annual: 0 },
        rewards: { program: "qff", earn: [{ rate: 1 }] },
        offers: [
          { id: "signup", source: "cdr", components: [{ kind: "signup_points", program: "qff", points: 150_000 }] }
        ]
      },
      1
    )

    const v = valued(e).valuation

    assert.strictEqual(v.bonusPoints, 150_000)
    assert.strictEqual(v.firstYearBonusPoints, undefined)
    assert.strictEqual(v.firstYear, 240)
  })

  test("expired offers are ignored", () => {
    const e = entry("expired", {
      fees: { annual: 100 },
      offers: [
        {
          id: "offer-4",
          source: "manual",
          components: [{ kind: "fee_discount", fee: "annual", payable: 0 }],
          valid_until: "2026-01-01"
        }
      ]
    })

    assert.strictEqual(valued(e).valuation.firstYearFee, 100)
  })
})

describe("card finder goals", () => {
  const rows = [
    valued(entry("cheap", { fees: { annual: 0, foreign_txn_pct: 3 }, rates: { purchase: 20 } })),
    valued(
      entry(
        "points",
        {
          fees: { annual: 100, foreign_txn_pct: 0 },
          rates: { purchase: 21 },
          rewards: { program: "qff", earn: [{ rate: 1 }] }
        },
        1
      )
    ),
    valued(entry("unknown", { fees: { annual: 0 }, rates: { purchase: 12 }, rewards: { program: "qff" } }, 1)),
    valued(
      entry("transfer", {
        fees: { annual: 50 },
        rates: { purchase: 19 },
        offers: [
          {
            id: "offer-5",
            source: "manual",
            components: [{ kind: "intro_rate", applies_to: "balance_transfer", rate: 0, months: 24 }]
          }
        ]
      })
    )
  ]

  const ids = (ranked: ReadonlyArray<Ranked>) => ranked.map((r) => r.entry.id)

  test("most back ranks by value after fees, with unknowns last", () => {
    assert.deepStrictEqual(ids(rank(rows, "value", today)), ["points", "cheap", "transfer", "unknown"])
  })

  test("overseas keeps only cards without a foreign transaction fee", () => {
    assert.deepStrictEqual(ids(rank(rows, "travel", today)), ["points"])
  })

  test("low interest ranks by purchase rate", () => {
    assert.deepStrictEqual(ids(rank(rows, "rate", today)), ["unknown", "transfer", "cheap", "points"])
  })

  test("balance transfer keeps cards with a current transfer offer", () => {
    assert.deepStrictEqual(ids(rank(rows, "transfer", today)), ["transfer"])
  })

  test("no annual fee keeps only free cards", () => {
    assert.deepStrictEqual(ids(rank(rows, "free", today)), ["cheap", "unknown"])
  })
})

test("entries carry issuer and program details", () => {
  const entries = entriesFrom({
    schema_version: 1,
    freshness: { card_count: 1, cdr_products_with_known_updated_at: 0 },
    programs: { qff: { name: "Qantas", type: "airline" } },
    issuers: { bank: { name: "Bank", cards: { gold: { ...base, rewards: { program: "qff" } } } } }
  })

  assert.strictEqual(entries[0]?.id, "bank/gold")
  assert.strictEqual(entries[0]?.program?.name, "Qantas")
})

test("storage writes that throw are reported rather than raised", () => {
  assert.strictEqual(
    attempt(() => {
      throw new Error("quota")
    }),
    false
  )
  assert.strictEqual(
    attempt(() => undefined),
    true
  )
})
