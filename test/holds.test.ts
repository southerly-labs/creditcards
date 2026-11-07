import { assert, describe, it, layer, test } from "@effect/vitest"
import { Effect, Array as EffectArray } from "effect"
import { Digest } from "effect/crypto"
import { Card } from "../src/model/schema.ts"
import type { Hold } from "../src/model/holds.ts"
import { HoldState } from "../src/machine/hold.ts"
import { SourceReview } from "../src/machine/review.ts"
import {
  type HoldCandidate,
  holdCandidates,
  holdId,
  resolveHolds,
  revertChange,
  withCdrEvidence
} from "../src/sync/holds.ts"
import { required } from "../src/util/required.ts"
import { initialLifecycle } from "../src/machine/cardLifecycle.ts"

const base: Card = {
  name: "Card",
  type: "personal",
  lifecycle: initialLifecycle,
  first_seen: "2026-10-31",
  fees: { annual: 100, foreign_txn_pct: 3 },
  rates: { purchase: 20 },
  limits: {},
  perks: {},
  rewards: { program: "qantas", earn: [{ rate: 1 }] },
  earn_state: SourceReview.cases.Parsed.make({ hash: "old" })
}

describe("field-level holds", () => {
  it.effect("only the suspicious field is held", () =>
    Effect.gen(function* () {
      const proposed = { ...base, fees: { annual: 1000, foreign_txn_pct: 2.5 } }
      const candidates = yield* holdCandidates(base, proposed)

      assert.deepStrictEqual(
        EffectArray.map(candidates, (c) => [c.change, c.kind, c.current, c.proposed]),
        [["fees.annual", "approve", 100, 1000]]
      )
      assert.deepStrictEqual(revertChange(proposed, base, "fees.annual")?.fees, { annual: 100, foreign_txn_pct: 2.5 })
    })
  )

  it.effect("a held earn rate reverts its review state with it", () =>
    Effect.gen(function* () {
      const proposed = {
        ...base,
        rewards: { program: "qantas", earn: [{ rate: 3 }] },
        earn_state: SourceReview.cases.Parsed.make({ hash: "new" })
      }

      assert.deepStrictEqual(
        EffectArray.map(yield* holdCandidates(base, proposed), (c) => c.change),
        ["rewards.earn"]
      )
      const reverted = revertChange(proposed, base, "rewards.earn")
      assert.deepStrictEqual(reverted?.rewards, base.rewards)
      assert.deepStrictEqual(reverted?.earn_state, base.earn_state)
    })
  )

  test("a revert that leaves the card invalid returns nothing", () => {
    const existing = { ...base, limits: { min_credit: 500, max_credit: 1000 } }
    const proposed = { ...base, limits: { min_credit: 5000, max_credit: 6000 } }

    assert.isUndefined(revertChange(proposed, existing, "limits.max_credit"))
  })
})

describe("resolving holds", () => {
  const approve = {
    change: "fees.annual",
    reason: "fees.annual 100 → 1000",
    kind: "approve" as const,
    current: 100,
    proposed: 1000
  }

  const confirm = {
    change: "offers.signup",
    reason: "offer ended",
    kind: "confirm" as const,
    current: [],
    proposed: undefined
  }

  const resolve = (candidate: HoldCandidate, entries: ReadonlyArray<Hold>, date: string) =>
    resolveHolds({ card: "bank/card", candidates: [candidate], entries, date })

  const recorded = resolve(approve, [], "2026-11-02").pipe(Effect.map((result) => required(result.holds[0])))

  layer(Digest.layerWebCrypto)((digest) => {
    digest.effect("a new suspicious change is reverted and recorded", () =>
      Effect.gen(function* () {
        assert.deepStrictEqual((yield* resolve(approve, [], "2026-11-02")).revert, [approve])
        assert.deepStrictEqual(yield* recorded, {
          id: yield* holdId("bank/card", "fees.annual", 1000),
          card: "bank/card",
          change: "fees.annual",
          reason: "fees.annual 100 → 1000",
          current: "100",
          proposed: "1000",
          since: "2026-11-02",
          state: HoldState.cases.AwaitingApproval.make({})
        })
      })
    )

    digest.effect("an approved change is applied and its entry dropped", () =>
      Effect.gen(function* () {
        const approved: Hold = {
          ...(yield* recorded),
          state: HoldState.cases.Approved.make({ on: "2026-11-02", evidence: "CDR says $1,000" })
        }

        const result = yield* resolve(approve, [approved], "2026-11-03")

        assert.deepStrictEqual(result.apply, [approve])
        assert.deepStrictEqual(result.holds, [])
      })
    )

    digest.effect("a rejected change stays reverted until CDR proposes something else", () =>
      Effect.gen(function* () {
        const rejected: Hold = {
          ...(yield* recorded),
          state: HoldState.cases.Rejected.make({ on: "2026-11-02", evidence: "parser misread" })
        }

        const other = { ...approve, proposed: 900 }
        const next = yield* resolve(other, [rejected], "2026-11-03")

        assert.deepStrictEqual((yield* resolve(approve, [rejected], "2026-11-03")).holds, [rejected])
        assert.deepStrictEqual(next.revert, [other])
        assert.deepStrictEqual(next.holds, [
          {
            ...(yield* recorded),
            id: yield* holdId("bank/card", "fees.annual", 900),
            proposed: "900",
            since: "2026-11-03"
          }
        ])
      })
    )

    digest.effect("a held change takes today's kind, so reports match how it will resolve", () =>
      Effect.gen(function* () {
        const confirmed = { ...approve, kind: "confirm" as const, reason: "confirmed by CDR", evidence: "snapshot" }
        const held = yield* resolve(confirmed, [yield* recorded], "2026-11-02")

        assert.deepStrictEqual(held.revert, [confirmed])
        assert.deepStrictEqual(held.holds[0]?.state, HoldState.cases.AwaitingConfirmation.make({}))
        assert.strictEqual(held.holds[0]?.reason, "confirmed by CDR")
        assert.strictEqual(held.holds[0]?.cdr_evidence, "snapshot")
        assert.strictEqual(held.holds[0]?.since, "2026-11-02")
        assert.deepStrictEqual(
          (yield* resolve(approve, held.holds, "2026-11-03")).holds[0]?.state,
          HoldState.cases.AwaitingApproval.make({})
        )
      })
    )

    digest.effect("a hold CDR no longer proposes is withdrawn, whatever its state", () =>
      Effect.gen(function* () {
        const rejected: Hold = {
          ...(yield* recorded),
          state: HoldState.cases.Rejected.make({ on: "2026-11-02", evidence: "parser misread" })
        }

        const quiet = yield* resolveHolds({
          card: "bank/card",
          candidates: [],
          entries: [yield* recorded, rejected],
          date: "2026-11-03"
        })

        assert.deepStrictEqual(quiet, { apply: [], revert: [], holds: [] })
      })
    )

    digest.effect("a confirm hold applies once it is still proposed on a later day", () =>
      Effect.gen(function* () {
        const first = yield* resolve(confirm, [], "2026-11-02")
        const nextDay = yield* resolve(confirm, first.holds, "2026-11-03")

        assert.deepStrictEqual(first.revert, [confirm])
        assert.deepStrictEqual((yield* resolve(confirm, first.holds, "2026-11-02")).revert, [confirm])
        assert.deepStrictEqual(nextDay.apply, [confirm])
        assert.deepStrictEqual(nextDay.holds, [])
      })
    )
  })
})

describe("offer holds", () => {
  const signup = (points: number, source: "parser" | "cdr" | "manual" = "parser") => ({
    id: "signup",
    source,
    components: [{ kind: "signup_points" as const, program: "qantas", points, year: 1 as const }] as const
  })

  const withSignup = (points: number, source?: "parser" | "cdr" | "manual") => ({
    ...base,
    offers: [signup(points, source)],
    signup_state: SourceReview.cases.Parsed.make({ hash: `h${points}` })
  })

  it.effect("a generated offer that disappears waits a day to confirm", () =>
    Effect.gen(function* () {
      const candidates = yield* holdCandidates(withSignup(100_000), base)

      assert.deepStrictEqual(
        EffectArray.map(candidates, (c) => [c.change, c.kind]),
        [["offers.signup", "confirm"]]
      )
      assert.deepStrictEqual(revertChange(base, withSignup(100_000), "offers.signup")?.offers, [signup(100_000)])
      assert.deepStrictEqual(
        revertChange(base, withSignup(100_000), "offers.signup")?.signup_state,
        SourceReview.cases.Parsed.make({ hash: "h100000" })
      )
    })
  )

  it.effect("a manual offer is never held", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* holdCandidates(withSignup(100_000, "manual"), base), [])
    })
  )

  it.effect("a signup increase over 50% needs approval; smaller changes and decreases apply", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        EffectArray.map(yield* holdCandidates(withSignup(100_000), withSignup(160_000)), (c) => [
          c.change,
          c.kind,
          c.reason
        ]),
        [["offers.signup", "approve", "signup points 100000 → 160000"]]
      )
      assert.deepStrictEqual(yield* holdCandidates(withSignup(100_000), withSignup(140_000)), [])
      assert.deepStrictEqual(yield* holdCandidates(withSignup(100_000), withSignup(20_000)), [])
      assert.deepStrictEqual(revertChange(withSignup(160_000), withSignup(100_000), "offers.signup")?.offers, [
        signup(100_000)
      ])
    })
  )
})

describe("CDR evidence for held changes", () => {
  const jump = Effect.map(holdCandidates(base, { ...base, fees: { annual: 450, foreign_txn_pct: 3 } }), (candidates) =>
    required(candidates[0])
  )

  const yesterday = { date: "2026-11-01", card: base }

  it.effect("a change the previous CDR snapshot does not make waits a day to confirm", () =>
    Effect.gen(function* () {
      const decided = yield* withCdrEvidence(yield* jump, yesterday)

      assert.strictEqual(decided.kind, "confirm")
      assert.strictEqual(decided.evidence, "CDR snapshot 2026-11-01 gives 100; today's gives 450")
    })
  )

  it.effect("a change the previous CDR snapshot already makes stays for a reviewer", () =>
    Effect.gen(function* () {
      const sameAsToday = { date: "2026-11-01", card: { ...base, fees: { annual: 450, foreign_txn_pct: 3 } } }

      assert.strictEqual((yield* withCdrEvidence(yield* jump, sameAsToday)).kind, "approve")
      assert.strictEqual((yield* withCdrEvidence(yield* jump, undefined)).kind, "approve")
    })
  )

  it.effect("a disappearing field or an implausible value stays for a reviewer", () =>
    Effect.gen(function* () {
      const gone = required((yield* holdCandidates(base, { ...base, fees: { foreign_txn_pct: 3 } }))[0])

      const earn = required(
        (yield* holdCandidates(base, {
          ...base,
          rewards: { ...base.rewards, program: "qantas", earn: [{ rate: 12 }] }
        }))[0]
      )

      assert.strictEqual((yield* withCdrEvidence(gone, yesterday)).kind, "approve")
      assert.strictEqual((yield* withCdrEvidence(earn, yesterday)).kind, "approve")
    })
  )
})
