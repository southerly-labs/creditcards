import { assert, describe, test } from "@effect/vitest"
import { Schema } from "effect"
import { Card } from "../src/model/schema.ts"
import { holdCandidates, revertChange } from "../src/sync/holds.ts"

const base = Schema.decodeUnknownSync(Card)({
  name: "Card",
  type: "personal",
  status: "active",
  first_seen: "2026-10-31",
  fees: { annual: 100, foreign_txn_pct: 3 },
  rates: { purchase: 20 },
  limits: {},
  perks: {},
  rewards: { program: "qantas", earn: [{ rate: 1 }], earn_source: "parser", earn_text_hash: "old" }
})

describe("field-level holds", () => {
  test("only the suspicious field is held", () => {
    const proposed = { ...base, fees: { annual: 1000, foreign_txn_pct: 2.5 } }
    const candidates = holdCandidates(base, proposed)

    assert.deepStrictEqual(
      candidates.map((c) => [c.change, c.kind, c.current, c.proposed]),
      [["fees.annual", "approve", 100, 1000]]
    )
    assert.deepStrictEqual(revertChange(proposed, base, "fees.annual")?.fees, { annual: 100, foreign_txn_pct: 2.5 })
  })

  test("a held earn rate reverts its source, hash and review with it", () => {
    const proposed = {
      ...base,
      rewards: { program: "qantas", earn: [{ rate: 3 }], earn_source: "parser" as const, earn_text_hash: "new" }
    }

    assert.deepStrictEqual(
      holdCandidates(base, proposed).map((c) => c.change),
      ["rewards.earn"]
    )
    assert.deepStrictEqual(revertChange(proposed, base, "rewards.earn")?.rewards, base.rewards)
  })

  test("a revert that leaves the card invalid returns nothing", () => {
    const existing = { ...base, limits: { min_credit: 500, max_credit: 1000 } }
    const proposed = { ...base, limits: { min_credit: 5000, max_credit: 6000 } }

    assert.isUndefined(revertChange(proposed, existing, "limits.max_credit"))
  })
})
