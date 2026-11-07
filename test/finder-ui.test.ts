import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  DialogEvent,
  DialogState,
  openDialog,
  stepDialog,
  stepTray,
  TrayEvent,
  TrayState,
  trayIds,
  trayOf
} from "../web/finder/ui.ts"

const browsing = DialogState.cases.Browsing.make({})
const sheet = (card: string) => DialogState.cases.Sheet.make({ card })
const closed = (dialog: "sheet" | "compare" | "values") => DialogEvent.cases.Closed.make({ dialog })

describe("finder dialogs", () => {
  it.effect("opens one dialog at a time; a card opened from the comparison replaces it", () =>
    Effect.gen(function* () {
      const comparing = yield* stepDialog(browsing, DialogEvent.cases.OpenCompare.make({}))
      assert.strictEqual(openDialog(comparing), "compare")

      const fromCompare = yield* stepDialog(comparing, DialogEvent.cases.OpenCard.make({ card: "x/a" }))
      assert.deepStrictEqual(fromCompare, sheet("x/a"))
      assert.deepStrictEqual(yield* stepDialog(fromCompare, closed("compare")), fromCompare)
      assert.deepStrictEqual(yield* stepDialog(fromCompare, closed("sheet")), browsing)
    })
  )

  it.effect("closes the comparison when the tray empties, and only the open dialog's close counts", () =>
    Effect.gen(function* () {
      const comparing = DialogState.cases.Comparing.make({})
      const values = DialogState.cases.Values.make({})

      assert.deepStrictEqual(yield* stepDialog(comparing, DialogEvent.cases.TrayEmptied.make({})), browsing)
      assert.deepStrictEqual(yield* stepDialog(sheet("x/a"), DialogEvent.cases.TrayEmptied.make({})), sheet("x/a"))
      assert.deepStrictEqual(yield* stepDialog(values, closed("sheet")), values)
      assert.deepStrictEqual(yield* stepDialog(values, DialogEvent.cases.OpenCard.make({ card: "x/a" })), values)
      assert.isUndefined(openDialog(browsing))
    })
  )
})

describe("compare tray", () => {
  const toggle = (id: string) => TrayEvent.cases.Toggle.make({ id, limit: 3 })

  it.effect("needs two cards to compare and drops the oldest past the limit", () =>
    Effect.gen(function* () {
      const one = yield* stepTray(trayOf([]), toggle("a"))
      assert.isTrue(TrayState.guards.Picking(one))

      const two = yield* stepTray(one, toggle("b"))
      assert.isTrue(TrayState.guards.Ready(two))

      const full = yield* stepTray(yield* stepTray(two, toggle("c")), toggle("d"))
      assert.deepStrictEqual(trayIds(full), ["b", "c", "d"])
    })
  )

  it.effect("removing cards steps back down, and clearing empties it", () =>
    Effect.gen(function* () {
      const two = trayOf(["a", "b"])

      assert.deepStrictEqual(yield* stepTray(two, toggle("a")), TrayState.cases.Picking.make({ ids: ["b"] }))
      assert.deepStrictEqual(yield* stepTray(trayOf(["a"]), toggle("a")), TrayState.cases.Empty.make({}))
      assert.deepStrictEqual(yield* stepTray(two, TrayEvent.cases.Clear.make({})), TrayState.cases.Empty.make({}))
    })
  )
})
