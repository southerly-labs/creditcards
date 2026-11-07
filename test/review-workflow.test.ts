import { assert, describe, it } from "@effect/vitest"
import { Array as EffectArray, Effect, Option } from "effect"
import { HoldState } from "../src/machine/hold.ts"
import {
  metricsRecord,
  type PreviousMetrics,
  reviewOpenCount,
  type TaskInputs,
  type TaskPage,
  type TaskReport,
  webhookItems
} from "../src/review/tasks.ts"

const empty: TaskReport = {
  rewards: { review: [] },
  bonus: { review: [] },
  held: [],
  holds: [],
  brandErrors: [],
  discontinued: []
}

const reviewCount = (pages: ReadonlyArray<TaskPage>, report: TaskReport = empty) => reviewOpenCount({ report, pages })

const blocked = { since: "2026-11-01", reason: "Challenge" }

describe("review issue", () => {
  it("stays open for unreadable pages, including standing blocks", () => {
    assert.strictEqual(reviewCount([{ missing: [], error: "HTTP 403" }]), 1)
    assert.strictEqual(reviewCount([{ missing: [], error: "HTTP 403", known_blocked: blocked }]), 1)
    assert.strictEqual(reviewCount([{ missing: [], attention: "Readable again" }]), 1)
    assert.strictEqual(reviewCount([{ missing: ["quote"] }]), 1)
    assert.strictEqual(reviewCount([{ missing: [] }]), 0)
  })

  it("stays open only for holds awaiting approval", () => {
    const hold = (state: HoldState) => ({ id: state._tag, card: "x/card", since: "2026-11-01", state })
    const decision = { on: "2026-11-02", evidence: "checked" }

    assert.strictEqual(reviewCount([], { ...empty, holds: [hold(HoldState.cases.AwaitingApproval.make({}))] }), 1)
    assert.strictEqual(
      reviewCount([], {
        ...empty,
        holds: [
          hold(HoldState.cases.AwaitingConfirmation.make({})),
          hold(HoldState.cases.Approved.make(decision)),
          hold(HoldState.cases.Rejected.make(decision))
        ]
      }),
      0
    )
  })

  it("stays open for other unresolved tasks", () => {
    assert.strictEqual(reviewCount([], { ...empty, brandErrors: [{ brand: "outage" }] }), 1)
  })
})

describe("review webhook", () => {
  it("excludes first-day missing cards and standing blocks but retains discontinuations", () => {
    const items = webhookItems({
      report: { ...empty, discontinued: ["x/gone"] },
      pages: [
        { card: "x/blocked", url: "https://a", missing: [], error: "HTTP 403", known_blocked: {} },
        { card: "x/error", url: "https://b", missing: [], error: "HTTP 404" }
      ]
    })

    assert.deepStrictEqual(items.discontinued, ["x/gone"])
    assert.deepStrictEqual(
      EffectArray.map(items.earn_check, (page) => page.card),
      ["x/error"]
    )
  })
})

const metrics = (input: Partial<TaskInputs> & { readonly previous?: PreviousMetrics }) =>
  metricsRecord({
    report: input.report === undefined ? empty : input.report,
    pages: input.pages === undefined ? [] : input.pages,
    previous: input.previous ?? {},
    outcomes: input.outcomes ?? { sync: "success" },
    run: "https://github.com/example/actions/runs/1",
    date: input.date ?? "2026-11-04"
  })

describe("daily autonomy metrics", () => {
  it.effect("distinguish standing blocks from human work and never call an unreadable run clear", () =>
    Effect.gen(function* () {
      const output = yield* metrics({
        pages: [{ card: "x/card", url: "https://example.com", missing: [], error: "HTTP 403", known_blocked: blocked }]
      })

      assert.deepStrictEqual(output.open_human_tasks, [])
      assert.isFalse(output.sync_clear)
      assert.deepStrictEqual(output.tasks_opened_today, {})
      assert.isTrue((yield* metrics({})).sync_clear)
    })
  )

  it.effect("preserve since across days and group new tasks by reason", () =>
    Effect.gen(function* () {
      const pages = [{ card: "x/card", url: "https://example.com", missing: [], error: "HTTP 403" }]

      const previous = {
        open_human_tasks: [{ id: "page:x/card:https://example.com", reason: "unreadable_page", since: "2026-11-03" }]
      }

      const output = yield* metrics({ pages, previous })

      assert.strictEqual(output.open_human_tasks[0]?.since, "2026-11-03")
      assert.deepStrictEqual(output.tasks_opened_today, {})
      assert.deepStrictEqual((yield* metrics({ pages })).tasks_opened_today, { unreadable_page: 1 })
      assert.deepStrictEqual((yield* metrics({ outcomes: { sync: "failure" } })).tasks_opened_today, {
        workflow_failure: 1
      })
    })
  )

  it.effect("missing outputs preserve existing work and add a failed verification task", () =>
    Effect.gen(function* () {
      const output = yield* metrics({ report: null, pages: null, outcomes: { sync: "failure", earn_pages: "skipped" } })
      const reasons = EffectArray.map(output.open_human_tasks, (task) => task.reason)

      assert.isFalse(output.sync_clear)
      assert.include(reasons, "workflow_failure")
      assert.include(reasons, "missing_sync_report")
      assert.include(reasons, "missing_earn_report")
    })
  )

  it.effect("same-day reruns retain task openings even after resolution", () =>
    Effect.gen(function* () {
      const output = yield* metrics({
        previous: {
          date: "2026-11-04",
          open_human_tasks: [],
          opened_today: [{ id: "earn:x/card", reason: "earn_review", since: "2026-11-04" }]
        }
      })

      assert.deepStrictEqual(output.open_human_tasks, [])
      assert.deepStrictEqual(output.tasks_opened_today, { earn_review: 1 })
    })
  )

  it.effect("missing reports retain earlier human tasks and their age", () =>
    Effect.gen(function* () {
      const output = yield* metrics({
        report: null,
        pages: null,
        previous: {
          open_human_tasks: [{ id: "earn:x/card", reason: "earn_review", card: "x/card", since: "2026-11-01" }]
        }
      })

      assert.strictEqual(
        Option.getOrUndefined(EffectArray.findFirst(output.open_human_tasks, (task) => task.id === "earn:x/card"))
          ?.since,
        "2026-11-01"
      )
      assert.strictEqual(output.tasks_opened_today["missing_sync_report"], 1)
    })
  )
})
