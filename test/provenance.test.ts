import { assert, test } from "@effect/vitest"
import { Schema } from "effect"
import { Card } from "../src/model/schema.ts"
import { sectionLocks } from "../src/provenance/schema.ts"
import { mergeCard } from "../src/sync/merge.ts"

test("section corrections and provenance survive CDR merging", () => {
  const existing = Schema.decodeUnknownSync(Card)({
    name: "Card",
    type: "personal",
    status: "active",
    fees: { annual: 25 },
    rates: {},
    limits: {},
    perks: {},
    locked: ["fees"],
    provenance: {
      sections: {
        fees: {
          source_urls: ["https://bank.example/terms"],
          reviewed_at: "2026-10-01T00:00:00Z",
          correction_reason: "CDR annual fee includes an optional service"
        }
      }
    }
  })

  const merged = mergeCard(existing, { ...existing, fees: { annual: 100 } })
  assert.deepStrictEqual(merged["fees"], { annual: 25 })
  assert.deepStrictEqual(merged["provenance"], existing.provenance)
})

test("a rewards correction locks only the CDR-owned rewards fields", () => {
  assert.deepStrictEqual(sectionLocks("rewards"), ["rewards.program", "rewards.partners"])
  assert.deepStrictEqual(sectionLocks("fees"), ["fees"])
})

test("a hand-set closed status survives CDR merging", () => {
  const closed = Schema.decodeUnknownSync(Card)({
    name: "Card",
    type: "personal",
    status: "closed",
    closed: "2025-06-01",
    fees: {},
    rates: {},
    limits: {},
    perks: {}
  })

  const merged = mergeCard(closed, { ...closed, status: "active" })
  assert.strictEqual(merged["status"], "closed")
  assert.strictEqual(merged["closed"], "2025-06-01")
  assert.strictEqual(
    mergeCard({ ...closed, status: "discontinued", discontinued: "2026-01-01" }, closed)["status"],
    "active"
  )
})

test("lifecycle dates must agree with the status", () => {
  const card = { name: "Card", type: "personal", fees: {}, rates: {}, limits: {}, perks: {} }

  assert.throws(() => {
    Schema.decodeUnknownSync(Card)({ ...card, status: "active", discontinued: "2026-01-01" })
  })
  assert.throws(() => {
    Schema.decodeUnknownSync(Card)({ ...card, status: "active", closed: "2026-01-01" })
  })
  assert.doesNotThrow(() => {
    Schema.decodeUnknownSync(Card)({
      ...card,
      status: "discontinued",
      closed: "2025-01-01",
      discontinued: "2026-01-01"
    })
  })
})
