import { assert, test } from "@effect/vitest"
import { Schema } from "effect"
import { Card } from "../src/model/schema.ts"
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
