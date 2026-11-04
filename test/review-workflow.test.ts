import { expect, test } from "@effect/vitest"

const empty = { rewards: { review: [] }, bonus: { review: [] }, held: [], holds: [], brandErrors: [], discontinued: [] }

function reviewCount(pages: string, report: unknown = empty): number {
  const result = Bun.spawnSync({
    cmd: ["jq", "-s", "-f", "tools/sync/review-open.jq"],
    stdin: new TextEncoder().encode(`${JSON.stringify(report)}\n${pages}`)
  })

  expect(result.exitCode).toBe(0)

  return Number(new TextDecoder().decode(result.stdout))
}

test("review issue stays open for unreadable pages, including standing blocks", () => {
  expect(reviewCount('[{"missing":[],"error":"HTTP 403"}]')).toBe(1)
  expect(reviewCount('[{"missing":[],"error":"HTTP 403","known_blocked":{"since":"2026-11-01"}}]')).toBe(1)
  expect(reviewCount('[{"missing":[],"attention":"Readable again"}]')).toBe(1)
  expect(reviewCount('[{"missing":["quote"]}]')).toBe(1)
  expect(reviewCount('[{"missing":[]}]')).toBe(0)
})

test("other unresolved tasks also prevent closure", () => {
  expect(reviewCount("[]", { ...empty, brandErrors: ["outage"] })).toBe(1)
})

test("the webhook excludes first-day missing cards and standing blocks but retains discontinuations", () => {
  const report = { ...empty, missing: ["commfcu/nsa-credit-card"], discontinued: ["x/gone"] }

  const pages =
    '[{"card":"x/blocked","missing":[],"error":"HTTP 403","known_blocked":{}},{"card":"x/error","missing":[],"error":"HTTP 404"}]'

  const result = Bun.spawnSync({
    cmd: ["jq", "-sc", "-f", "tools/sync/webhook.jq"],
    stdin: new TextEncoder().encode(`${JSON.stringify(report)}\n${pages}`)
  })

  const output = new TextDecoder().decode(result.stdout)

  expect(result.exitCode).toBe(0)
  expect(output).toContain("x/gone")
  expect(output).toContain("x/error")
  expect(output).not.toContain("commfcu/nsa-credit-card")
  expect(output).not.toContain("x/blocked")
})

function metrics(input: {
  readonly report?: unknown
  readonly pages?: unknown
  readonly previous?: unknown
  readonly outcomes?: unknown
  readonly date?: string
}): string {
  const result = Bun.spawnSync({
    cmd: [
      "jq",
      "-sc",
      "--arg",
      "date",
      input.date ?? "2026-11-04",
      "--arg",
      "run",
      "https://github.com/example/actions/runs/1",
      "--argjson",
      "outcomes",
      JSON.stringify(input.outcomes ?? { sync: "success" }),
      "-f",
      "tools/sync/metrics.jq"
    ],
    stdin: new TextEncoder().encode(
      `${JSON.stringify(input.report === undefined ? empty : input.report)}\n${JSON.stringify(input.pages === undefined ? [] : input.pages)}\n${JSON.stringify(input.previous ?? {})}`
    )
  })

  expect(result.exitCode).toBe(0)

  return new TextDecoder().decode(result.stdout)
}

test("metrics distinguish standing blocks from human work and never call an unreadable run clear", () => {
  const output = metrics({
    pages: [
      {
        card: "x/card",
        url: "https://example.com",
        missing: [],
        error: "HTTP 403",
        known_blocked: { since: "2026-11-01", reason: "Challenge" }
      }
    ]
  })

  expect(output).toContain('"open_human_tasks":[]')
  expect(output).toContain('"sync_clear":false')
  expect(output).toContain('"tasks_opened_today":{}')
  expect(metrics({})).toContain('"sync_clear":true')
})

test("metrics preserve since across days and group new tasks by reason", () => {
  const pages = [{ card: "x/card", url: "https://example.com", missing: [], error: "HTTP 403" }]

  const previous = {
    open_human_tasks: [{ id: "page:x/card:https://example.com", reason: "unreadable_page", since: "2026-11-03" }]
  }

  const output = metrics({ pages, previous })

  expect(output).toContain('"since":"2026-11-03"')
  expect(output).toContain('"tasks_opened_today":{}')
  expect(metrics({ pages })).toContain('"tasks_opened_today":{"unreadable_page":1}')
  expect(metrics({ outcomes: { sync: "failure" } })).toContain('"workflow_failure":1')
})

test("missing outputs preserve existing work and add a failed verification task", () => {
  const output = metrics({ report: null, pages: null, outcomes: { sync: "failure", earn_pages: "skipped" } })

  expect(output).toContain('"sync_clear":false')
  expect(output).toContain("workflow_failure")
  expect(output).toContain("missing_sync_report")
  expect(output).toContain("missing_earn_report")
})

test("same-day reruns retain task openings even after resolution", () => {
  const previous = {
    date: "2026-11-04",
    open_human_tasks: [],
    opened_today: [{ id: "earn:x/card", reason: "earn_review", since: "2026-11-04" }]
  }

  const output = metrics({ previous })

  expect(output).toContain('"open_human_tasks":[]')
  expect(output).toContain('"tasks_opened_today":{"earn_review":1}')
})

test("missing reports retain earlier human tasks and their age", () => {
  const previous = {
    open_human_tasks: [{ id: "earn:x/card", reason: "earn_review", card: "x/card", since: "2026-11-01" }]
  }

  const output = metrics({ report: null, pages: null, previous })

  expect(output).toContain('"since":"2026-11-01"')
  expect(output).toContain('"missing_sync_report":1')
})
