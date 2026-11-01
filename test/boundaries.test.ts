import { assert, test } from "@effect/vitest"
import {
  decodeApi,
  decodeColumnVisibility,
  decodeMonthlySpend,
  decodePointValues,
  loadColumnVisibility,
  loadMonthlySpend,
  loadPointValues
} from "../src/model/api.ts"
import { encodeJson } from "../src/util/json.ts"

const empty = {
  schema_version: 1,
  freshness: { card_count: 0, cdr_products_with_known_updated_at: 0 },
  programs: {},
  issuers: {}
}

test("the public API boundary rejects malformed card data", () => {
  assert.throws(() => {
    decodeApi({ ...empty, issuers: { bank: { name: "Bank", cards: { card: { name: "Card" } } } } })
  })
  assert.deepStrictEqual(decodeApi(empty), empty)
})

test("point values preserve valid entries alongside invalid ones", () => {
  assert.deepStrictEqual(decodePointValues('{"qantas":1.5,"negative":-1,"text":"2","null":null}'), { qantas: 1.5 })
  assert.deepStrictEqual(decodePointValues("not json"), {})
  assert.deepStrictEqual(decodePointValues("null"), {})
})

const unavailableStorage = (): never => {
  throw new Error("Storage access denied")
}

test("unavailable browser storage falls back to default point values", () => {
  assert.deepStrictEqual(loadPointValues(unavailableStorage), {})
  assert.deepStrictEqual(
    loadPointValues(() => null),
    {}
  )
})

test("column visibility keeps only boolean choices", () => {
  assert.deepStrictEqual(decodeColumnVisibility('{"purchase":true,"fx":false,"text":"yes","n":1}'), {
    purchase: true,
    fx: false
  })
  assert.deepStrictEqual(decodeColumnVisibility("not json"), {})
  assert.deepStrictEqual(loadColumnVisibility(unavailableStorage), {})
})

test("monthly spend keeps only non-negative numbers", () => {
  assert.strictEqual(decodeMonthlySpend("2500"), 2500)
  assert.strictEqual(decodeMonthlySpend(""), undefined)
  assert.strictEqual(decodeMonthlySpend("-1"), undefined)
  assert.strictEqual(decodeMonthlySpend("lots"), undefined)
  assert.strictEqual(loadMonthlySpend(unavailableStorage), undefined)
})

test("Schema serialization preserves optional report fields and pretty output", () => {
  assert.strictEqual(encodeJson({ omitted: undefined, kept: [undefined, 1] }), '{"kept":[null,1]}')
  assert.strictEqual(encodeJson({ kept: 1 }, 2), '{\n  "kept": 1\n}')
})
