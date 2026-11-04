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
