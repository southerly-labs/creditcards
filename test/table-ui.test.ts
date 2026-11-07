import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  choiceOf,
  SortEvent,
  SortState,
  stepSort,
  stepVisibility,
  Visibility,
  VisibilityEvent,
  visibilityOf
} from "../web/table-ui.ts"

const click = (column: number) => SortEvent.cases.HeaderClicked.make({ column })

describe("table sort", () => {
  it.effect("clicking the sorted column flips it; another column sorts ascending", () =>
    Effect.gen(function* () {
      const ascending = SortState.cases.Ascending.make({ column: 2 })
      const descending = yield* stepSort(ascending, click(2))

      assert.deepStrictEqual(descending, SortState.cases.Descending.make({ column: 2 }))
      assert.deepStrictEqual(yield* stepSort(descending, click(2)), ascending)
      assert.deepStrictEqual(yield* stepSort(descending, click(5)), SortState.cases.Ascending.make({ column: 5 }))
      assert.deepStrictEqual(yield* stepSort(ascending, click(5)), SortState.cases.Ascending.make({ column: 5 }))
    })
  )
})

describe("column visibility", () => {
  const picked = (checked: boolean, shownByDefault: boolean) =>
    VisibilityEvent.cases.Picked.make({ checked, shownByDefault })

  it.effect("stores only choices that differ from the column's default", () =>
    Effect.gen(function* () {
      const fallback = Visibility.cases.Default.make({})

      assert.deepStrictEqual(yield* stepVisibility(fallback, picked(false, true)), Visibility.cases.Hidden.make({}))
      assert.deepStrictEqual(yield* stepVisibility(fallback, picked(true, false)), Visibility.cases.Shown.make({}))
      assert.deepStrictEqual(yield* stepVisibility(Visibility.cases.Hidden.make({}), picked(true, true)), fallback)
      assert.deepStrictEqual(
        yield* stepVisibility(Visibility.cases.Shown.make({}), VisibilityEvent.cases.Reset.make({})),
        fallback
      )
    })
  )

  it("round-trips the stored choice", () => {
    for (const choice of [undefined, true, false]) assert.strictEqual(choiceOf(visibilityOf(choice)), choice)
  })
})
