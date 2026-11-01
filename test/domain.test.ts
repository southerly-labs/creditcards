import { assert, test } from "@effect/vitest"
import { Schema } from "effect"
import { Card } from "../src/model/schema.ts"
import { CalendarDate, Timestamp, WebUrl, orderedTiers, recognizesLock } from "../src/model/domain.ts"

test("credit limits and count fields reject impossible values", () => {
  const card = { name: "Test", type: "personal", status: "active", fees: {}, rates: {}, limits: {}, perks: {} }
  assert.isTrue(Schema.is(Card)(card))
  assert.isFalse(Schema.is(Card)({ ...card, limits: { min_credit: 1000, max_credit: 500 } }))
  assert.isFalse(Schema.is(Card)({ ...card, rates: { interest_free_days: 1.5 } }))
  assert.isTrue(Schema.is(Card)({ ...card, locked: ["fees", "rewards.earn", "limits.max_credit"] }))
  assert.isFalse(Schema.is(Card)({ ...card, locked: ["fees.typo"] }))
})

test("tiers compare within categories and cap periods", () => {
  assert.isTrue(orderedTiers([{ cap_monthly: 100 }, { category: "travel", cap_monthly: 50 }, {}]))
  assert.isFalse(orderedTiers([{ cap_monthly: 100 }, { cap_monthly: 100 }]))
  assert.isFalse(orderedTiers([{}, { cap_monthly: 100 }]))
  assert.isFalse(orderedTiers([{ cap_annual: 200 }, { cap_annual: 100 }]))
  assert.isTrue(orderedTiers([{ cap_monthly: 100 }, { cap_monthly: 200 }]))
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
