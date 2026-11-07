import { assert, it, test } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"
import { Card } from "../src/model/schema.ts"
import { sectionLocks } from "../src/provenance/schema.ts"
import { mergeCard } from "../src/sync/merge.ts"
import { notSeen, seen, statusOf, withLifecycle } from "../src/model/lifecycle.ts"

test("section corrections and provenance survive CDR merging", () => {
  const existing: Card = {
    name: "Card",
    type: "personal",
    status: "active",
    first_seen: "2026-10-31",
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
  }

  const merged = mergeCard(existing, { ...existing, fees: { annual: 100 } })
  assert.deepStrictEqual(merged["fees"], { annual: 25 })
  assert.deepStrictEqual(merged["provenance"], existing.provenance)
})

test("a rewards correction locks only the CDR-owned rewards fields", () => {
  assert.deepStrictEqual(sectionLocks("rewards"), ["rewards.program", "rewards.partners"])
  assert.deepStrictEqual(sectionLocks("fees"), ["fees"])
})

it.effect("a hand-set closed status survives CDR merging", () =>
  Effect.gen(function* () {
    const closed: Card = {
      name: "Card",
      type: "personal",
      status: "closed",
      first_seen: "2026-10-31",
      closed: "2025-06-01",
      fees: {},
      rates: {},
      limits: {},
      perks: {}
    }

    const merged = statusOf(withLifecycle(closed, yield* seen(closed)))
    assert.strictEqual(merged.status, "closed")
    assert.strictEqual(merged.closed, "2025-06-01")

    const delisted: Card = { ...closed, status: "discontinued", discontinued: "2026-01-01" }
    assert.strictEqual(statusOf(withLifecycle(delisted, yield* seen(delisted))).status, "closed")

    const { closed: _closed, ...sellingFields } = delisted
    const selling: Card = sellingFields
    assert.strictEqual(statusOf(withLifecycle(selling, yield* seen(selling))).status, "active")
  })
)

const decodes = (input: unknown) =>
  Effect.exit(Schema.decodeUnknownEffect(Card)(input)).pipe(Effect.map(Exit.isSuccess))

it.effect("lifecycle dates must agree with the status", () =>
  Effect.gen(function* () {
    const card = { name: "Card", type: "personal", fees: {}, rates: {}, limits: {}, perks: {} }

    assert.isFalse(yield* decodes({ ...card, status: "active", discontinued: "2026-01-01" }))
    assert.isFalse(yield* decodes({ ...card, status: "active", closed: "2026-01-01" }))
    assert.isTrue(
      yield* decodes({
        ...card,
        status: "discontinued",
        first_seen: "2026-10-31",
        closed: "2025-01-01",
        discontinued: "2026-01-01"
      })
    )
  })
)

it.effect("a card must be missing on two different days before it is discontinued", () =>
  Effect.gen(function* () {
    const card: Card = {
      name: "Card",
      type: "personal",
      status: "active",
      first_seen: "2026-10-31",
      fees: {},
      rates: {},
      limits: {},
      perks: {}
    }

    const marked = withLifecycle(card, yield* notSeen(card, "2026-11-01"))
    assert.strictEqual(statusOf(marked).missing_since, "2026-11-01")
    assert.deepStrictEqual(withLifecycle(marked, yield* notSeen(marked, "2026-11-01")), marked)

    const gone = statusOf(withLifecycle(marked, yield* notSeen(marked, "2026-11-02")))
    assert.strictEqual(gone.status, "discontinued")
    assert.strictEqual(gone.discontinued, "2026-11-01")
    assert.isUndefined(gone.missing_since)
    assert.isUndefined(statusOf(withLifecycle(marked, yield* seen(marked))).missing_since)
  })
)
