import { assert, layer, test } from "@effect/vitest"
import { Effect } from "effect"
import { Digest } from "effect/crypto"
import { checkReferences, ValidationError } from "../src/build/build.ts"
import { holdIdProblems } from "../src/build/holdChecks.ts"
import { initialLifecycle } from "../src/machine/cardLifecycle.ts"
import { HoldState } from "../src/machine/hold.ts"
import type { Hold } from "../src/model/holds.ts"
import type { Card } from "../src/model/schema.ts"
import type { Offer } from "../src/offers/schema.ts"
import type { Dataset } from "../src/store/Store.ts"
import type { HoldCandidate } from "../src/sync/holds.ts"
import { holdId, resolveHolds } from "../src/sync/holds.ts"
import { required } from "../src/util/required.ts"

const card: Card = {
  name: "Card",
  type: "personal",
  lifecycle: initialLifecycle,
  first_seen: "2026-10-31",
  fees: {},
  rates: {},
  limits: {},
  perks: {}
}

const dataset = (cards: ReadonlyMap<string, Card>, holds: ReadonlyArray<Hold> = []): Dataset => ({
  issuers: new Map([["bank", { name: "Bank", cdr_brands: [] }]]),
  programs: new Map(),
  cards,
  holds
})

test("a validation error's message lists its problems", () => {
  assert.strictEqual(ValidationError.make({ problems: ["a: one", "b: two"] }).message, "a: one\nb: two")
})

const section = (reviewed_at: string) => ({
  source_urls: ["https://example.com/card"] as const,
  reviewed_at,
  correction_reason: "from the issuer's page"
})

test("stored provenance holds only corrections that a lock protects", () => {
  const corrected: Card = {
    ...card,
    locked: ["network", "rewards.program"],
    provenance: {
      cdr_observed_at: "2026-11-01T20:00:00Z",
      cdr_changed_on: "2026-11-01",
      sections: {
        network: section("2026-11-04T23:15:29.057Z"),
        rewards: section("2026-11-04"),
        fees: section("last week")
      }
    }
  }

  assert.deepStrictEqual(checkReferences(dataset(new Map([["bank/card", corrected]]))), [
    "bank/card: provenance.cdr_observed_at is derived at build time and must not be stored",
    "bank/card: provenance.cdr_changed_on is derived at build time and must not be stored",
    "bank/card: provenance.sections.fees records a correction but nothing under fees is locked",
    "bank/card: provenance.sections.fees.reviewed_at is not a date or timestamp"
  ])
})

const hold = (overrides: Partial<Hold>): Hold => ({
  id: "000000000000",
  card: "bank/card",
  change: "fees.annual",
  reason: "fees.annual 100 → 1000",
  since: "2026-11-02",
  state: HoldState.cases.AwaitingApproval.make({}),
  ...overrides
})

test("hold entries name a held change, store JSON values and are decided after they were held", () => {
  const holds = [
    hold({ id: "aaaaaaaaaaaa", current: "100", proposed: "1000" }),
    hold({ id: "bbbbbbbbbbbb", change: "offers.signup" }),
    hold({ id: "cccccccccccc", change: "first_seen" }),
    hold({ id: "dddddddddddd", proposed: "{not json" }),
    hold({
      id: "eeeeeeeeeeee",
      state: HoldState.cases.Approved.make({ on: "2026-11-01", evidence: "checked the issuer page" })
    })
  ]

  assert.deepStrictEqual(checkReferences(dataset(new Map([["bank/card", card]]), holds)), [
    "sync-holds: cccccccccccc: first_seen is not a change the sync holds",
    "sync-holds: dddddddddddd: proposed is not JSON",
    "sync-holds: eeeeeeeeeeee: decided on 2026-11-01, before it was held on 2026-11-02"
  ])
})

const offer: Offer = {
  id: "signup",
  source: "parser",
  components: [{ kind: "signup_points", program: "points", points: 150_000, year: 1 }]
}

const candidates: ReadonlyArray<HoldCandidate> = [
  { change: "fees.annual", reason: "fees.annual 100 → 1000", kind: "approve", current: 100, proposed: 1000 },
  { change: "offers.signup", reason: "signup points", kind: "approve", current: undefined, proposed: offer },
  { change: "offers.intro-purchase", reason: "gone", kind: "confirm", current: offer, proposed: undefined }
]

layer(Digest.layerWebCrypto)((it) => {
  it.effect("a stored hold's id can be recomputed from its card, change and proposed value", () =>
    Effect.gen(function* () {
      const { holds } = yield* resolveHolds({ card: "bank/card", candidates, entries: [], date: "2026-11-02" })

      assert.strictEqual(holds.length, 3)
      assert.deepStrictEqual(yield* holdIdProblems(holds), [])

      const first = required(holds[0])
      const tampered: Hold = { ...first, proposed: "2000" }

      assert.deepStrictEqual(yield* holdIdProblems([tampered]), [
        `sync-holds: ${tampered.id} does not match its card, change and proposed value (expected ${yield* holdId("bank/card", "fees.annual", 2000)})`
      ])
    })
  )
})
