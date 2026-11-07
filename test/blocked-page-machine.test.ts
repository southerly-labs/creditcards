import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { BLOCKED_REASON, PageEvent, PageState, pageAttention, stepPage } from "../src/machine/blockedPage.ts"

const readable = PageState.cases.Readable.make({})

const blocked = PageState.cases.Blocked.make({
  reason: "Cloudflare challenge",
  evidence: "HTTP 403",
  since: "2026-11-04"
})

const failed = (error: string, date = "2026-11-07") => PageEvent.cases.Failed.make({ error, date })

describe("blocked page machine", () => {
  it.effect("a failure blocks a readable page, dated that day", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* stepPage(readable, failed("HTTP 403")),
        PageState.cases.Blocked.make({ reason: BLOCKED_REASON, evidence: "HTTP 403", since: "2026-11-07" })
      )
      assert.deepStrictEqual(yield* stepPage(readable, PageEvent.cases.Read.make({})), readable)
    })
  )

  it.effect("a blocked page keeps its reason and date, updates its evidence, and clears once readable", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* stepPage(blocked, failed("HTTP 403")), blocked)
      assert.deepStrictEqual(
        yield* stepPage(blocked, failed("HTTP 503")),
        PageState.cases.Blocked.make({ ...blocked, evidence: "HTTP 503" })
      )
      assert.deepStrictEqual(yield* stepPage(blocked, PageEvent.cases.Read.make({})), readable)
    })
  )

  it("raises attention on the run a page clears or changes, and after 30 days blocked", () => {
    const changed = PageState.cases.Blocked.make({ ...blocked, evidence: "HTTP 503" })

    assert.strictEqual(pageAttention(blocked, readable, "2026-11-07"), "Previously blocked page is readable again")
    assert.strictEqual(pageAttention(blocked, changed, "2026-11-07"), "Blocked page status changed")
    assert.isUndefined(pageAttention(blocked, blocked, "2026-11-07"))
    assert.isUndefined(pageAttention(readable, readable, "2026-11-07"))
    assert.strictEqual(
      pageAttention(blocked, blocked, "2026-12-04"),
      "Page has been blocked for 30 days; review the source"
    )
  })
})
