import { BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Array as EffectArray, Option } from "effect"
import { IssueAction, planIssue } from "../../src/machine/reviewIssue.ts"
import type { EarnCheck } from "../../src/model/schema.ts"
import { rewardsIssueEvent } from "../../src/review/issue.ts"
import { type HumanTask, openHumanTasks, pageNeedsReview, type TaskPage } from "../../src/review/tasks.ts"
import { type CheckResult, classifyCheck, nextKnownBlocked } from "../../src/rewards/check.ts"
import { tlaModule, tlaRows } from "./tla.ts"

const TODAY = "2026-12-02"
const RECENT = "2026-12-01"
const OLD = "2026-11-01"
const CARD = "example/card"
const URL = "https://bank.example/rewards"

const BLOCKED = ["none", "e1-recent", "e1-old"] as const

type Blocked = (typeof BLOCKED)[number]

const RESULTS = ["ok", "e1", "e2"] as const

type PageResult = (typeof RESULTS)[number]

const ERRORS: Readonly<Record<string, string>> = { e1: "HTTP 403; cf-mitigated: challenge", e2: "HTTP 503" }

const blockedOf = (blocked: Blocked): EarnCheck["known_blocked"] =>
  blocked === "none"
    ? undefined
    : { reason: "Issuer page unreadable", evidence: ERRORS["e1"] ?? "", since: blocked === "e1-old" ? OLD : RECENT }

const resultOf = (result: PageResult): CheckResult =>
  result === "ok"
    ? { card: CARD, url: URL, missing: [] }
    : { card: CARD, url: URL, missing: [], error: ERRORS[result] ?? "" }

const evidenceName = (evidence: string) => (evidence === ERRORS["e1"] ? "e1" : "e2")

const nextName = (next: EarnCheck["known_blocked"]): string => {
  if (next === undefined) return "none"

  return `${evidenceName(next.evidence)}-${next.since === TODAY ? "today" : "kept"}`
}

const asTaskPage = (checked: CheckResult): TaskPage => ({
  card: checked.card,
  url: checked.url,
  missing: checked.missing,
  ...(checked.error === undefined ? {} : { error: checked.error }),
  ...(checked.attention === undefined ? {} : { attention: checked.attention }),
  ...(checked.known_blocked === undefined ? {} : { known_blocked: checked.known_blocked })
})

const classifyRow = Effect.fn("classifyRow")(function* (blocked: Blocked, result: PageResult) {
  const checked = yield* classifyCheck({ result: resultOf(result), blocked: blockedOf(blocked), date: TODAY })
  const next = yield* nextKnownBlocked({ result: resultOf(result), blocked: blockedOf(blocked), date: TODAY })
  const page = asTaskPage(checked)
  const open = yield* planIssue(undefined, rewardsIssueEvent({ report: {}, pages: [page] }, true))

  return [blocked, result, pageNeedsReview(page), IssueAction.guards.Create(open), nextName(next)]
})

const issueRow = Effect.fn("issueRow")(function* (open: boolean, items: boolean, checked: boolean) {
  const pages: ReadonlyArray<TaskPage> = items ? [{ card: CARD, url: URL, missing: ["quote"] }] : []
  const action = yield* planIssue(open ? 7 : undefined, rewardsIssueEvent({ report: {}, pages }, checked))

  return [open, items, checked, action._tag]
})

const PREVIOUS = ["none", "open"] as const

const PAGES = ["needs", "fine", "missing"] as const

const pageTask = (reason: string, since: string): HumanTask => ({
  id: `page:${CARD}:${URL}`,
  reason,
  card: CARD,
  url: URL,
  since
})

const taskRow = Effect.fn("taskRow")(function* (previous: (typeof PREVIOUS)[number], pages: (typeof PAGES)[number]) {
  const page: TaskPage = { card: CARD, url: URL, missing: [], error: ERRORS["e1"] ?? "" }

  const reported: Readonly<Record<(typeof PAGES)[number], ReadonlyArray<TaskPage> | null>> = {
    needs: [page],
    fine: [],
    missing: null
  }

  const tasks = yield* openHumanTasks({
    report: { date: TODAY },
    pages: reported[pages],
    previous: { date: RECENT, open_human_tasks: previous === "open" ? [pageTask("unreadable_page", RECENT)] : [] },
    outcomes: pages === "missing" ? { earn_pages: "failure" } : { earn_pages: "success" },
    run: "https://github.com/example/runs/1",
    date: TODAY
  })

  const found = Option.getOrUndefined(EffectArray.findFirst(tasks, (task) => task.id === `page:${CARD}:${URL}`))
  const since = found === undefined ? "none" : found.since === TODAY ? "today" : "kept"

  return [previous, pages, found !== undefined, since]
})

const program = Effect.gen(function* () {
  const classifyRows = yield* Effect.forEach(
    EffectArray.flatMap(BLOCKED, (blocked) => EffectArray.map(RESULTS, (result) => [blocked, result] as const)),
    ([blocked, result]) => classifyRow(blocked, result)
  )

  const issueRows = yield* Effect.forEach(
    EffectArray.flatMap([true, false], (open) =>
      EffectArray.flatMap([true, false], (items) =>
        EffectArray.map([true, false], (checked) => [open, items, checked] as const)
      )
    ),
    ([open, items, checked]) => issueRow(open, items, checked)
  )

  const taskRows = yield* Effect.forEach(
    EffectArray.flatMap(PREVIOUS, (previous) => EffectArray.map(PAGES, (pages) => [previous, pages] as const)),
    ([previous, pages]) => taskRow(previous, pages)
  )

  yield* Console.log(
    tlaModule(
      "ReviewQueueCode",
      [
        "src/rewards/check.ts (classifyCheck, nextKnownBlocked)",
        "src/machine/blockedPage.ts",
        "src/review/tasks.ts (pageNeedsReview, reviewOpenCount, openHumanTasks)",
        "src/review/issue.ts",
        "src/machine/reviewIssue.ts (planIssue)",
        "src/machine/humanTask.ts"
      ],
      [tlaRows("ClassifyRows", classifyRows), tlaRows("IssueRows", issueRows), tlaRows("TaskRows", taskRows)]
    )
  )
})

BunRuntime.runMain(program)
