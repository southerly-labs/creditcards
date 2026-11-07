import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { OfferSlot, OfferSlotEvent, offerIn, slotOf, stepOfferSlot } from "../src/machine/offerSlot.ts"
import type { Offer } from "../src/offers/schema.ts"

const generated: Offer = {
  id: "signup",
  source: "cdr",
  components: [{ kind: "signup_points", program: "qantas", points: 1 }]
}

const manual: Offer = { ...generated, source: "manual" }

const regenerated = (offer?: Offer) => OfferSlotEvent.cases.Regenerated.make(offer === undefined ? {} : { offer })

describe("offer slot machine", () => {
  it.effect("generated offers follow what CDR and the parser produce", () =>
    Effect.gen(function* () {
      const replaced: Offer = { ...generated, components: [{ kind: "signup_points", program: "qantas", points: 2 }] }

      assert.deepStrictEqual(offerIn(yield* stepOfferSlot(slotOf(undefined), regenerated(generated))), generated)
      assert.deepStrictEqual(offerIn(yield* stepOfferSlot(slotOf(generated), regenerated(replaced))), replaced)
      assert.deepStrictEqual(yield* stepOfferSlot(slotOf(generated), regenerated()), OfferSlot.cases.Absent.make({}))
      assert.deepStrictEqual(yield* stepOfferSlot(slotOf(undefined), regenerated()), OfferSlot.cases.Absent.make({}))
    })
  )

  it.effect("a manual offer is never replaced or removed by regeneration", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(offerIn(yield* stepOfferSlot(slotOf(manual), regenerated(generated))), manual)
      assert.deepStrictEqual(offerIn(yield* stepOfferSlot(slotOf(manual), regenerated())), manual)
    })
  )
})
