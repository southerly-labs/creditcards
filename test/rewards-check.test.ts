import { assert, describe, expect, layer, test } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import type { Card } from "../src/model/schema.ts"
import { checkEarnPages, formatCheck, htmlText, missingQuotes, normaliseText } from "../src/rewards/check.ts"

describe("page text", () => {
  test("drops scripts, styles and comments, and separates elements", () => {
    const html = `<html><head><style>.a{}</style><script>var earn = "9 points"</script></head>
      <body><!-- 9 points --><p>1 PT</p><p>Per whole AU&#36;1 on&nbsp;International&#x20;Spend &amp; more</p></body></html>`
    const text = normaliseText(htmlText(html))
    expect(text).toBe("1 pt per whole au$1 on international spend & more")
  })

  test("normalises case, whitespace, quotes and dashes", () => {
    expect(normaliseText("Coles’ Rewards – 2  Flybuys\n Points")).toBe("coles' rewards - 2 flybuys points")
  })
})

describe("missing quotes", () => {
  const page =
    "Earn rate for the Qantas Money Everyday credit card: 1 Qantas Point per whole AU$1 equivalent on\nInternational Spend; 0.75 Qantas Points per whole AU$1 on Domestic Spend"

  test("matches regardless of case and line wrapping", () => {
    expect(missingQuotes(page, ["1 qantas point per whole AU$1 equivalent on international spend"])).toEqual([])
  })

  test("reports a quote whose rate changed", () => {
    const changed = page.replace("0.75", "0.6")
    expect(
      missingQuotes(changed, ["0.75 Qantas Points per whole AU$1 on Domestic Spend", "on International Spend"])
    ).toEqual(["0.75 Qantas Points per whole AU$1 on Domestic Spend"])
  })
})

describe("checkEarnPages", () => {
  const card = (url: string, quote: string, status: Card["status"] = "active"): Card => ({
    name: "Card",
    type: "personal",
    status,
    fees: {},
    rates: {},
    limits: {},
    perks: {},
    rewards: { program: "qantas", earn: [{ rate: 1 }], earn_source: "manual", earn_check: [{ url, expect: [quote] }] }
  })
  const pages: Record<string, Response> = {
    "https://a.example/card": new Response("<p>Earn 1 point per $1</p>", { headers: { "content-type": "text/html" } })
  }
  let fetches = 0
  const respond: Parameters<typeof HttpClient.make>[0] = (request, url) => {
    fetches++
    const page = pages[url.toString()]
    return Effect.succeed(HttpClientResponse.fromWeb(request, page?.clone() ?? new Response("gone", { status: 404 })))
  }
  const client = HttpClient.make(respond)

  layer(Layer.succeed(HttpClient.HttpClient, client))((it) => {
    it.effect("checks each card, fetching each page once, and skips discontinued cards", () =>
      Effect.gen(function* () {
        fetches = 0
        const results = yield* checkEarnPages(
          new Map([
            ["x/ok", card("https://a.example/card", "1 point per $1")],
            ["x/changed", card("https://a.example/card", "2 points per $1")],
            ["x/gone", card("https://a.example/missing", "1 point per $1")],
            ["x/old", card("https://a.example/card", "3 points per $1", "discontinued")]
          ])
        )
        assert.strictEqual(fetches, 2)
        assert.deepStrictEqual(results, [
          { card: "x/ok", url: "https://a.example/card", missing: [] },
          { card: "x/changed", url: "https://a.example/card", missing: ["2 points per $1"] },
          { card: "x/gone", url: "https://a.example/missing", missing: [], error: "HTTP 404" }
        ])
        const report = formatCheck(results)
        assert.include(report, "3 checked, 1 changed, 1 unreadable")
        assert.include(report, "- [ ] `x/changed` — https://a.example/card")
        assert.include(report, "`x/gone` — https://a.example/missing: HTTP 404")
      })
    )
  })
})
