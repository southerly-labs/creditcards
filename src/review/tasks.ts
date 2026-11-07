import { Array as EffectArray, Effect, Option, Order, Predicate, Record as EffectRecord, Schema } from "effect"
import { stepTask, TaskEvent, TaskState } from "../machine/humanTask.ts"

const Hold = Schema.Struct({
  id: Schema.String,
  card: Schema.String,
  since: Schema.optionalKey(Schema.String),
  state: Schema.Struct({ _tag: Schema.String })
})

const CardItem = Schema.Struct({ card: Schema.String })

export const TaskReport = Schema.Struct({
  date: Schema.optionalKey(Schema.String),
  holds: Schema.optionalKey(Schema.Array(Hold)),
  held: Schema.optionalKey(Schema.Array(CardItem)),
  rewards: Schema.optionalKey(Schema.Struct({ review: Schema.optionalKey(Schema.Array(CardItem)) })),
  bonus: Schema.optionalKey(Schema.Struct({ review: Schema.optionalKey(Schema.Array(CardItem)) })),
  discontinued: Schema.optionalKey(Schema.Array(Schema.String)),
  brandErrors: Schema.optionalKey(Schema.Array(Schema.Struct({ brand: Schema.String })))
})

export type TaskReport = typeof TaskReport.Type

export const TaskPage = Schema.Struct({
  card: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  missing: Schema.Array(Schema.String),
  error: Schema.optionalKey(Schema.NullOr(Schema.String)),
  attention: Schema.optionalKey(Schema.NullOr(Schema.String)),
  known_blocked: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({ since: Schema.optionalKey(Schema.String), reason: Schema.optionalKey(Schema.String) })
    )
  )
})

export type TaskPage = typeof TaskPage.Type

export const HumanTask = Schema.Struct({
  id: Schema.String,
  reason: Schema.String,
  card: Schema.optionalKey(Schema.String),
  brand: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  since: Schema.optionalKey(Schema.String)
})

export type HumanTask = typeof HumanTask.Type

export const PreviousMetrics = Schema.Struct({
  date: Schema.optionalKey(Schema.String),
  open_human_tasks: Schema.optionalKey(Schema.Array(HumanTask)),
  opened_today: Schema.optionalKey(Schema.Array(HumanTask))
})

export type PreviousMetrics = typeof PreviousMetrics.Type

const present = (value: string | null | undefined): value is string => value !== undefined && value !== null

const isBlocked = (page: TaskPage) => page.known_blocked !== undefined && page.known_blocked !== null

export const pageNeedsReview = (page: TaskPage): boolean =>
  page.missing.length > 0 || present(page.attention) || (present(page.error) && !isBlocked(page))

const pageReason = (page: TaskPage) =>
  present(page.attention) ? "blocked_page_changed" : present(page.error) ? "unreadable_page" : "earn_page_changed"

export const awaitingApproval = (report: TaskReport) =>
  EffectArray.filter(report.holds ?? [], (hold) => Predicate.isTagged(hold.state, "AwaitingApproval"))

const reportTasks = (report: TaskReport, today: string, run: string): ReadonlyArray<HumanTask> => [
  ...EffectArray.map(awaitingApproval(report), (hold) => ({
    id: `hold:${hold.id}`,
    reason: "held_change",
    card: hold.card,
    since: hold.since ?? today
  })),
  ...EffectArray.map(report.held ?? [], ({ card }) => ({ id: `held:${card}`, reason: "held_card", card })),
  ...EffectArray.map(report.rewards?.review ?? [], ({ card }) => ({ id: `earn:${card}`, reason: "earn_review", card })),
  ...EffectArray.map(report.bonus?.review ?? [], ({ card }) => ({ id: `bonus:${card}`, reason: "bonus_review", card })),
  ...EffectArray.map(report.discontinued ?? [], (card) => ({
    id: `discontinued:${card}`,
    reason: "discontinued",
    card
  })),
  ...EffectArray.map(report.brandErrors ?? [], ({ brand }) => ({
    id: `brand:${brand}`,
    reason: "brand_error",
    brand,
    url: run
  }))
]

const pageTasks = (pages: ReadonlyArray<TaskPage>): ReadonlyArray<HumanTask> =>
  EffectArray.map(EffectArray.filter(pages, pageNeedsReview), (page) => ({
    id: `page:${page.card ?? "null"}:${page.url ?? "null"}`,
    reason: pageReason(page),
    ...(page.card === undefined ? {} : { card: page.card }),
    ...(page.url === undefined ? {} : { url: page.url })
  }))

const byId = Order.mapInput(Order.String, (task: HumanTask) => task.id)

function uniqueBy(tasks: ReadonlyArray<HumanTask>, key: (task: HumanTask) => string): ReadonlyArray<HumanTask> {
  const seen = new Set<string>()
  const unique: Array<HumanTask> = []

  for (const task of EffectArray.sortWith(tasks, key, Order.String)) {
    if (seen.has(key(task))) continue
    seen.add(key(task))
    unique.push(task)
  }

  return unique
}

export interface TaskInputs {
  readonly report: TaskReport | null
  readonly pages: ReadonlyArray<TaskPage> | null
  readonly previous: PreviousMetrics
  readonly outcomes: Readonly<Record<string, string>>
  readonly run: string
  readonly date: string
}

const observedTasks = (input: TaskInputs, today: string): ReadonlyArray<HumanTask> => [
  ...(input.report === null ? [] : reportTasks(input.report, today, input.run)),
  ...(input.pages === null ? [] : pageTasks(input.pages)),
  ...EffectArray.map(
    EffectArray.filter(EffectRecord.toEntries(input.outcomes), ([, outcome]) => outcome !== "success"),
    ([step]) => ({ id: `workflow:${step}`, reason: "workflow_failure", url: input.run })
  ),
  ...(input.report === null ? [{ id: "report:sync", reason: "missing_sync_report", url: input.run }] : []),
  ...(input.pages === null ? [{ id: "report:pages", reason: "missing_earn_report", url: input.run }] : []),
  ...(input.report === null || input.pages === null ? (input.previous.open_human_tasks ?? []) : [])
]

const withLifecycle = Effect.fn("humanTask.withLifecycle")(function* (
  task: HumanTask,
  previous: ReadonlyArray<HumanTask>,
  today: string
) {
  const old = Option.getOrUndefined(
    EffectArray.findFirst(previous, (entry) => entry.id === task.id && entry.reason === task.reason)
  )

  const before =
    old === undefined ? TaskState.cases.Absent.make({}) : TaskState.cases.Open.make({ since: old.since ?? today })

  const after = yield* stepTask(before, TaskEvent.cases.Observed.make({ since: task.since ?? today }))

  return TaskState.guards.Open(after) ? { ...task, since: after.since } : task
})

export const openHumanTasks = Effect.fn("openHumanTasks")(function* (input: TaskInputs) {
  const today = input.report?.date ?? input.date
  const previous = input.previous.open_human_tasks ?? []

  return yield* Effect.forEach(
    uniqueBy(observedTasks(input, today), (task) => task.id),
    (task) => withLifecycle(task, previous, today)
  )
})

export const metricsRecord = Effect.fn("metricsRecord")(function* (input: TaskInputs) {
  const today = input.report?.date ?? input.date
  const tasks = yield* openHumanTasks(input)
  const pages = input.pages ?? []

  const opened = uniqueBy(
    [
      ...(input.previous.date === today ? (input.previous.opened_today ?? []) : []),
      ...EffectArray.filter(tasks, (task) => task.since === today)
    ],
    (task) => `${task.id}\u0000${task.reason}`
  )

  const openedByReason: Record<string, number> = {}

  for (const task of EffectArray.sortWith(opened, (t) => t.reason, Order.String))
    openedByReason[task.reason] = (openedByReason[task.reason] ?? 0) + 1

  return {
    date: today,
    run: input.run,
    workflow_results: input.outcomes,
    open_human_tasks: tasks,
    known_blocked: EffectArray.map(EffectArray.filter(pages, isBlocked), (page) => ({
      card: page.card ?? null,
      url: page.url ?? null,
      evidence: page.error ?? null,
      since: page.known_blocked?.since ?? null,
      reason: page.known_blocked?.reason ?? null
    })),
    sync_clear: tasks.length === 0 && !EffectArray.some(pages, (page) => present(page.error)),
    opened_today: opened,
    tasks_opened_today: openedByReason
  }
})

export const sortedById = (tasks: ReadonlyArray<HumanTask>) => EffectArray.sort(tasks, byId)

export interface QueueInput {
  readonly report: TaskReport
  readonly pages: ReadonlyArray<TaskPage>
}

export const reviewOpenCount = ({ report, pages }: QueueInput): number =>
  (report.rewards?.review ?? []).length +
  (report.bonus?.review ?? []).length +
  (report.held ?? []).length +
  awaitingApproval(report).length +
  (report.brandErrors ?? []).length +
  (report.discontinued ?? []).length +
  EffectArray.filter(pages, (page) => page.missing.length > 0 || present(page.error) || present(page.attention)).length

export const webhookItems = ({ report, pages }: QueueInput) => ({
  holds: EffectArray.map(awaitingApproval(report), (hold) => hold.id),
  held: EffectArray.map(report.held ?? [], (item) => item.card),
  earn: EffectArray.map(report.rewards?.review ?? [], (item) => item.card),
  bonus: EffectArray.map(report.bonus?.review ?? [], (item) => item.card),
  earn_check: EffectArray.map(EffectArray.filter(pages, pageNeedsReview), (page) => ({
    card: page.card ?? null,
    url: page.url ?? null,
    error: page.error ?? null,
    attention: page.attention ?? null,
    missing: page.missing
  })),
  discontinued: report.discontinued ?? [],
  brands: EffectArray.map(report.brandErrors ?? [], (item) => item.brand)
})
