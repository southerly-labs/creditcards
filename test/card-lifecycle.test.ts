import { assert, describe, it } from "@effect/vitest"
import { Machine } from "@typeonce/effect-machine"
import { MachineTest } from "@typeonce/effect-machine/testing"
import { Array as EffectArray, Effect, Schema } from "effect"
import {
  CardLifecycleEvent,
  CardLifecycleMachine,
  CardLifecycleStates,
  type CardLifecycle,
  type FlatLifecycle,
  flatFromLifecycle,
  initialLifecycle,
  lifecycleFromFlat,
  ListingState,
  SalesState,
  stepLifecycle,
  toSnapshot
} from "../src/machine/cardLifecycle.ts"
import { encodedSnapshot, regionNodes } from "../src/machine/snapshot.ts"
import { Card } from "../src/model/schema.ts"

const { Seen, NotSeen, Close, Reopen } = CardLifecycleEvent.cases
const { Listed, Missing, Delisted } = ListingState.cases
const { Selling, Closed } = SalesState.cases

const regionPaths = [
  ["Lifecycle.listing.Listed", "Lifecycle.listing.Missing", "Lifecycle.listing.Delisted"],
  ["Lifecycle.sales.Selling", "Lifecycle.sales.Closed"]
] as const

const run = Effect.fn("run")(function* (start: CardLifecycle, events: ReadonlyArray<CardLifecycleEvent>) {
  let lifecycle = start

  for (const event of events) lifecycle = yield* stepLifecycle(lifecycle, event)

  return lifecycle
})

describe("card lifecycle", () => {
  it.effect("marks a card missing, waits out the same day, then delists it dated when it went missing", () =>
    Effect.gen(function* () {
      const missing = yield* run(initialLifecycle, [NotSeen.make({ date: "2026-11-06" })])
      assert.deepStrictEqual(missing.listing, Missing.make({ since: "2026-11-06" }))

      const sameDay = yield* stepLifecycle(missing, NotSeen.make({ date: "2026-11-06" }))
      assert.deepStrictEqual(sameDay, missing)

      const delisted = yield* stepLifecycle(missing, NotSeen.make({ date: "2026-11-07" }))
      assert.deepStrictEqual(delisted.listing, Delisted.make({ on: "2026-11-06" }))
      assert.deepStrictEqual(yield* stepLifecycle(delisted, NotSeen.make({ date: "2026-11-08" })), delisted)
    })
  )

  it.effect("returns a missing or delisted card to listed when it is seen again", () =>
    Effect.gen(function* () {
      const missing = { listing: Missing.make({ since: "2026-11-06" }), sales: Selling.make({}) }
      const delisted = { listing: Delisted.make({ on: "2026-11-01" }), sales: Selling.make({}) }

      assert.deepStrictEqual((yield* stepLifecycle(missing, Seen.make({}))).listing, Listed.make({}))
      assert.deepStrictEqual((yield* stepLifecycle(delisted, Seen.make({}))).listing, Listed.make({}))
      assert.deepStrictEqual(yield* stepLifecycle(initialLifecycle, Seen.make({})), initialLifecycle)
    })
  )

  it.effect("tracks sales independently of listing", () =>
    Effect.gen(function* () {
      const closed = yield* run(initialLifecycle, [
        Close.make({ on: "2026-10-01" }),
        NotSeen.make({ date: "2026-11-06" })
      ])

      assert.deepStrictEqual(closed, {
        listing: Missing.make({ since: "2026-11-06" }),
        sales: Closed.make({ on: "2026-10-01" })
      })

      const delisted = yield* stepLifecycle(closed, NotSeen.make({ date: "2026-11-07" }))
      assert.deepStrictEqual(delisted.sales, Closed.make({ on: "2026-10-01" }))
      assert.deepStrictEqual((yield* stepLifecycle(delisted, Reopen.make({}))).sales, Selling.make({}))
      assert.deepStrictEqual(yield* stepLifecycle(closed, Close.make({ on: "2026-11-01" })), closed)
    })
  )

  it.effect("never leaves a card without exactly one listing and one sales state", () =>
    Effect.gen(function* () {
      const define = MachineTest.invariants(CardLifecycleMachine)

      const trace = yield* MachineTest.run(CardLifecycleMachine, {
        events: [
          NotSeen.make({ date: "2026-11-01" }),
          Close.make({}),
          NotSeen.make({ date: "2026-11-02" }),
          Seen.make({}),
          Reopen.make({})
        ]
      })

      yield* MachineTest.verify(CardLifecycleMachine, trace)
      yield* MachineTest.checkInvariants(CardLifecycleMachine, trace, [
        define.state(
          "one state per region",
          ({ snapshot }) =>
            EffectArray.filter(
              regionPaths,
              (paths) => EffectArray.filter(paths, (path) => CardLifecycleStates.matches(snapshot, path)).length === 1
            ).length === regionPaths.length || "a region has zero or several active states"
        )
      ])
    })
  )
})

describe("card lifecycle persistence", () => {
  const recorded: ReadonlyArray<readonly [FlatLifecycle, CardLifecycle]> = [
    [{ status: "active" }, initialLifecycle],
    [
      { status: "closed", missing_since: "2026-11-07" },
      { listing: Missing.make({ since: "2026-11-07" }), sales: Closed.make({}) }
    ],
    [
      { status: "closed", closed: "2026-10-01" },
      { listing: Listed.make({}), sales: Closed.make({ on: "2026-10-01" }) }
    ],
    [
      { status: "discontinued", discontinued: "2026-11-05" },
      { listing: Delisted.make({ on: "2026-11-05" }), sales: Selling.make({}) }
    ],
    [
      { status: "discontinued", closed: "2026-09-01", discontinued: "2026-11-05" },
      { listing: Delisted.make({ on: "2026-11-05" }), sales: Closed.make({ on: "2026-09-01" }) }
    ]
  ]

  it("maps every flat status combination to a lifecycle and back", () => {
    for (const [flat, lifecycle] of recorded) {
      assert.deepStrictEqual(lifecycleFromFlat(flat), lifecycle)
      assert.deepStrictEqual(flatFromLifecycle(lifecycle), flat)
    }
  })

  it.effect("builds snapshots in the format the machine encodes", () =>
    Effect.gen(function* () {
      for (const [, lifecycle] of recorded) {
        const encoded = yield* Machine.encodeSnapshot(CardLifecycleMachine, yield* toSnapshot(lifecycle))
        assert.deepStrictEqual(encoded, encodedSnapshot(regionNodes("Lifecycle", lifecycle)))
      }
    })
  )
})

describe("card schema with a lifecycle", () => {
  const card = {
    name: "Test",
    type: "personal",
    status: "closed",
    first_seen: "2026-10-31",
    missing_since: "2026-11-07",
    fees: {},
    rates: {},
    limits: {},
    perks: {}
  }

  it("accepts a lifecycle that agrees with the flat status fields", () => {
    assert.isTrue(Schema.is(Card)(card))
    assert.isTrue(
      Schema.is(Card)({ ...card, lifecycle: lifecycleFromFlat({ status: "closed", missing_since: "2026-11-07" }) })
    )
  })

  it("needs a discontinued date exactly when the status is discontinued", () => {
    const { missing_since: _since, ...listed } = card

    assert.isTrue(Schema.is(Card)({ ...listed, status: "discontinued", discontinued: "2026-11-05" }))
    assert.isFalse(Schema.is(Card)({ ...listed, status: "discontinued" }))
    assert.isFalse(Schema.is(Card)({ ...listed, status: "active", discontinued: "2026-11-05" }))
  })

  it("rejects a lifecycle that disagrees with them", () => {
    assert.isFalse(Schema.is(Card)({ ...card, lifecycle: initialLifecycle }))
    assert.isFalse(
      Schema.is(Card)({
        ...card,
        lifecycle: { listing: Missing.make({ since: "2026-11-06" }), sales: Closed.make({}) }
      })
    )
  })
})
