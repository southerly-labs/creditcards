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
