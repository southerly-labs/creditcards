import { assert, test } from "@effect/vitest"
import { checkReferences, toApi } from "../src/build/build.ts"
import { decodeApi } from "../src/api/contract.ts"
import type { Dataset } from "../src/store/Store.ts"

test("public output round trips and legacy envelopes remain readable", () => {
  const dataset: Dataset = { cards: new Map(), programs: new Map(), issuers: new Map() }
  const api = toApi(dataset)
  assert.deepStrictEqual(decodeApi(api), api)
  assert.strictEqual(api.schema_version, 1)
  assert.deepStrictEqual(api.freshness, { card_count: 0, cdr_products_with_known_updated_at: 0 })
  assert.deepStrictEqual(decodeApi({ programs: {}, issuers: {} }), { programs: {}, issuers: {} })
})

test("public projection retains review evidence and excludes storage controls", () => {
  const dataset: Dataset = {
    issuers: new Map([["bank", { name: "Bank", cdr_brands: ["brand"] }]]),
    programs: new Map([["points", { name: "Points", type: "bank", aliases: ["points"], priority: 1 }]]),
    cards: new Map([
      [
        "bank/card",
        {
          name: "Card",
          type: "personal",
          status: "active",
          locked: ["fees.annual"],
          fees: {},
          rates: {},
          limits: {},
          perks: {},
          cdr: { brand: "brand", product_id: "1", last_updated: "2025-01-01T00:00:00Z" },
          rewards: {
            program: "points",
            earn_source: "manual",
            earn_text_hash: "hash",
            earn_check: [{ url: "https://example.com", expect: ["points"] }]
          }
        }
      ]
    ])
  }

  const api = toApi(dataset, "2026-01-01T00:00:00Z")
  assert.deepStrictEqual(decodeApi(api), api)
  assert.strictEqual(api.freshness?.cdr_latest_product_updated_at, "2025-01-01T00:00:00.000Z")
  assert.strictEqual(api.freshness?.cdr_products_with_known_updated_at, 1)
  assert.strictEqual(JSON.stringify(api).includes('"locked"'), false)
  assert.strictEqual(JSON.stringify(api).includes('"aliases"'), false)
  assert.strictEqual(JSON.stringify(api).includes('"earn_text_hash":"hash"'), true)
})

const card = {
  name: "Card",
  type: "personal",
  status: "active",
  fees: {},
  rates: {},
  limits: {},
  perks: {}
} as const

test("public cards keep card-level domain checks", () => {
  const api = (limits: { readonly min_credit: number; readonly max_credit: number }) => ({
    programs: {},
    issuers: { bank: { name: "Bank", cards: { card: { ...card, limits } } } }
  })

  assert.throws(() => {
    decodeApi(api({ min_credit: 10_000, max_credit: 1000 }))
  })
  assert.doesNotThrow(() => {
    decodeApi(api({ min_credit: 1000, max_credit: 10_000 }))
  })
})

test("offer signup programs must reference known programs", () => {
  const dataset: Dataset = {
    issuers: new Map([["bank", { name: "Bank", cdr_brands: [] }]]),
    programs: new Map(),
    cards: new Map([
      [
        "bank/card",
        { ...card, offers: [{ components: [{ kind: "signup_points", program: "missing", points: 100_000 }] }] }
      ]
    ])
  }

  assert.deepStrictEqual(checkReferences(dataset), ["bank/card: unknown program missing"])
})

test("CDR observations publish on cards and must reference known cards", () => {
  const dataset: Dataset = {
    issuers: new Map([["bank", { name: "Bank", cdr_brands: [] }]]),
    programs: new Map(),
    cards: new Map([["bank/card", card]]),
    observations: new Map([
      ["bank/card", "2026-11-01T20:00:00Z"],
      ["bank/gone", "2026-11-01T20:00:00Z"]
    ])
  }

  const api = toApi(dataset)
  assert.deepStrictEqual(decodeApi(api), api)
  assert.strictEqual(api.issuers["bank"]?.cards["card"]?.provenance?.cdr_observed_at, "2026-11-01T20:00:00Z")
  assert.deepStrictEqual(checkReferences(dataset), ["cdr-observations: unknown card bank/gone"])
})
