import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { fetched, FetchState, reportedFailure, settleFetch, stepFetch } from "../src/machine/brandFetch.ts"

const first = FetchState.cases.FirstTry.make({})

describe("brand fetch machine", () => {
  it.effect("a listed brand is done; a 4xx gives up at once; anything else is retried once", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* stepFetch(first, fetched(undefined)), FetchState.cases.Done.make({}))
      assert.deepStrictEqual(
        yield* stepFetch(first, fetched("HTTP 404")),
        FetchState.cases.GaveUp.make({ error: "HTTP 404" })
      )

      const retrying = yield* stepFetch(first, fetched("HTTP 503"))
      assert.deepStrictEqual(retrying, FetchState.cases.Retrying.make({ error: "HTTP 503" }))
      assert.deepStrictEqual(yield* settleFetch(retrying, undefined), FetchState.cases.Done.make({}))
      assert.deepStrictEqual(
        yield* settleFetch(retrying, "timeout"),
        FetchState.cases.GaveUp.make({ error: "timeout" })
      )
    })
  )

  it("reports a brand that gave up after a retry, but not one refused with a 4xx", () => {
    assert.isTrue(reportedFailure(FetchState.cases.GaveUp.make({ error: "timeout" })))
    assert.isFalse(reportedFailure(FetchState.cases.GaveUp.make({ error: "HTTP 403" })))
    assert.isFalse(reportedFailure(FetchState.cases.Done.make({})))
  })
})
