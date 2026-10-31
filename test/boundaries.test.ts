import { assert, test } from "@effect/vitest"
import {
  decodeApi,
  decodeColumnVisibility,
  decodePointValues,
  loadColumnVisibility,
  loadPointValues
} from "../src/model/api.ts"
import { encodeJson } from "../src/util/json.ts"

test("the public API boundary rejects malformed card data", () => {
  assert.throws(() => {
    decodeApi({ programs: {}, issuers: { bank: { name: "Bank", cards: { card: { name: "Card" } } } } })
  })
  assert.deepStrictEqual(decodeApi({ programs: {}, issuers: {} }), { programs: {}, issuers: {} })
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

test("Schema serialization preserves optional report fields and pretty output", () => {
  assert.strictEqual(encodeJson({ omitted: undefined, kept: [undefined, 1] }), '{"kept":[null,1]}')
  assert.strictEqual(encodeJson({ kept: 1 }, 2), '{\n  "kept": 1\n}')
})
