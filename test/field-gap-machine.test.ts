import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { GapEvent, GapState, observeGaps, stepGap } from "../src/machine/fieldGap.ts"
import type { FieldGap } from "../src/model/schema.ts"

const gap: FieldGap = { field: "fees.late_payment", reason: "not_fixed", checked: "2026-11-05", sources: ["cdr"] }
const observed = (present: boolean) => GapEvent.cases.Observed.make({ present })

describe("field gap machine", () => {
  it.effect("an explained gap lasts until CDR or a hand edit fills the field", () =>
    Effect.gen(function* () {
      const explained = GapState.cases.Explained.make({ gap })

      assert.deepStrictEqual(yield* stepGap(explained, observed(false)), explained)
      assert.deepStrictEqual(yield* stepGap(explained, observed(true)), GapState.cases.Known.make({}))
    })
  )

  it.effect("a field that loses its value is unexplained until someone records why", () =>
    Effect.gen(function* () {
      const unexplained = yield* stepGap(GapState.cases.Known.make({}), observed(false))
      assert.deepStrictEqual(unexplained, GapState.cases.Unexplained.make({}))
      assert.deepStrictEqual(
        yield* stepGap(unexplained, GapEvent.cases.Explain.make({ gap })),
        GapState.cases.Explained.make({ gap })
      )
    })
  )

  it.effect("keeps only the gaps whose fields are still empty", () =>
    Effect.gen(function* () {
      const other: FieldGap = { ...gap, field: "rates.interest_free_days" }

      assert.deepStrictEqual(yield* observeGaps([gap, other], (field) => field === "fees.late_payment"), [other])
    })
  )
})
