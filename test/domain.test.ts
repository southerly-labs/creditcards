import { assert, test } from "@effect/vitest"
import { Schema } from "effect"
import { Card, EarnRate } from "../src/model/schema.ts"
import { initialLifecycle } from "../src/machine/cardLifecycle.ts"
import { CalendarDate, Timestamp, WebUrl, orderedTiers, recognizesLock } from "../src/model/domain.ts"

test("credit limits and count fields reject impossible values", () => {
  const card = {
    name: "Test",
    type: "personal",
    lifecycle: initialLifecycle,
    first_seen: "2026-10-31",
    fees: {},
    rates: {},
    limits: {},
    perks: {}
  }

  assert.isTrue(Schema.is(Card)(card))
  assert.isFalse(Schema.is(Card)({ ...card, limits: { min_credit: 1000, max_credit: 500 } }))
  assert.isFalse(Schema.is(Card)({ ...card, rates: { interest_free_days: 1.5 } }))
  assert.isTrue(Schema.is(Card)({ ...card, locked: ["fees", "rewards.earn", "limits.max_credit"] }))
  assert.isFalse(Schema.is(Card)({ ...card, locked: ["fees.typo"] }))
})

test("field gaps name a decision field once, with a dated source", () => {
  const card = {
    name: "Test",
    type: "personal",
    lifecycle: initialLifecycle,
    first_seen: "2026-10-31",
    fees: {},
    rates: {},
    limits: {},
    perks: {}
  }

  const gap = {
    field: "fees.late_payment",
    reason: "not_stated",
    checked: "2026-11-05",
    sources: ["cdr", "https://bank.example/fees.pdf"]
  }

  assert.isTrue(Schema.is(Card)({ ...card, gaps: [gap, { ...gap, field: "network" }] }))
  assert.isTrue(Schema.is(Card)({ ...card, gaps: [{ ...gap, reason: "not_applicable" }] }))
  assert.isFalse(Schema.is(Card)({ ...card, gaps: [{ ...gap, reason: "unknown" }] }))
  assert.isFalse(Schema.is(Card)({ ...card, gaps: [gap, gap] }))
  assert.isFalse(Schema.is(Card)({ ...card, gaps: [{ ...gap, field: "fees.additional_card" }] }))
  assert.isFalse(Schema.is(Card)({ ...card, gaps: [{ ...gap, sources: [] }] }))
  assert.isFalse(Schema.is(Card)({ ...card, gaps: [{ ...gap, sources: ["bank.example"] }] }))
  assert.isFalse(Schema.is(Card)({ ...card, gaps: [{ ...gap, checked: "5 Nov" }] }))
})

test("tiers compare within categories and cap periods", () => {
  assert.isTrue(orderedTiers([{ cap_monthly: 100 }, { category: "travel", cap_monthly: 50 }, {}]))
  assert.isFalse(orderedTiers([{ cap_monthly: 100 }, { cap_monthly: 100 }]))
  assert.isFalse(orderedTiers([{}, { cap_monthly: 100 }]))
  assert.isFalse(orderedTiers([{ cap_annual: 200 }, { cap_annual: 100 }]))
  assert.isTrue(orderedTiers([{ cap_monthly: 100 }, { cap_monthly: 200 }]))
})

test("signup points are in the card's own rewards program", () => {
  const card = {
    name: "Test",
    type: "personal",
    lifecycle: initialLifecycle,
    first_seen: "2026-10-31",
    fees: {},
    rates: {},
    limits: {},
    perks: {},
    rewards: { program: "points" }
  }

  const offer = (program: string) => ({
    id: "signup",
    source: "manual",
    components: [{ kind: "signup_points", program, points: 50_000, year: 1 }]
  })

  assert.isTrue(Schema.is(Card)({ ...card, offers: [offer("points")] }))
  assert.isFalse(Schema.is(Card)({ ...card, offers: [offer("partner")] }))
})

test("the base earn tier has no category rather than an empty one", () => {
  assert.isTrue(Schema.is(EarnRate)({ rate: 1 }))
  assert.isTrue(Schema.is(EarnRate)({ rate: 2, category: "travel" }))
  assert.isFalse(Schema.is(EarnRate)({ rate: 1, category: "" }))
})

test("dates and URLs must be real and complete", () => {
  assert.isTrue(Schema.is(CalendarDate)("2024-02-29"))
  assert.isFalse(Schema.is(CalendarDate)("2025-02-29"))
  assert.isFalse(Schema.is(CalendarDate)("2025-1-1"))
  assert.isTrue(Schema.is(Timestamp)("2025-01-01T12:00:00+10:00"))
  assert.isFalse(Schema.is(Timestamp)("2025-01-01"))
  assert.isTrue(Schema.is(WebUrl)("https://example.com/terms"))
  assert.isFalse(Schema.is(WebUrl)("https://"))
  assert.isFalse(Schema.is(WebUrl)("javascript:alert(1)"))
})

test("lock recognition expands with the schema, including absent parent fields", () => {
  const extended = Schema.Struct({ future: Schema.optionalKey(Schema.Struct({ value: Schema.String })) })
  assert.isTrue(recognizesLock(extended.ast, "future"))
  assert.isTrue(recognizesLock(extended.ast, "future.value"))
  assert.isFalse(recognizesLock(extended.ast, "future.value.child"))
  assert.isFalse(recognizesLock(extended.ast, ""))
})
