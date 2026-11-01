import { assert, test } from "@effect/vitest"
import { issuerSeed } from "../src/sync/issuers.ts"

test("issuer slugs keep Australia when it is part of the brand name", () => {
  assert.strictEqual(issuerSeed("Bank Australia").slug, "bank-australia")
  assert.strictEqual(issuerSeed("Regional Australia Bank").slug, "regional-australia-bank")
  assert.strictEqual(issuerSeed("Australian Mutual Bank LTD").slug, "australian-mutual-bank")
  assert.strictEqual(issuerSeed("HSBC Bank Australia Limited").slug, "hsbc-bank")
  assert.strictEqual(issuerSeed("Example Pty Ltd").slug, "example")
})
