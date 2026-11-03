import { required } from "../util/required.ts"
import { Effect, Result, Schedule, Schema, Array as EffectArray, String as EffectString, pipe } from "effect"
import { HttpClient } from "effect/http"
import { extractText, getDocumentProxy } from "unpdf"
import type { Card } from "../model/schema.ts"

export class PageError extends Schema.TaggedError<PageError>()("PageError", {
  url: Schema.String,
  message: Schema.String
}) {}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  hellip: "...",
  deg: "°",
  reg: "®",
  trade: "™",
  dollar: "$"
}

const decodeEntity = (match: string, name: string): string => {
  if (name[0] === "#") {
    const code =
      name[1] === "x" || name[1] === "X"
        ? parseInt(pipe(name, EffectString.slice(2)), 16)
        : Math.trunc(Number(pipe(name, EffectString.slice(1))))

    return Number.isFinite(code) ? String.fromCodePoint(code) : match
  }

  return NAMED_ENTITIES[EffectString.toLowerCase(name)] ?? match
}

const decodeEntities = (s: string) =>
  EffectArray.join(
    EffectArray.map(EffectString.split(s, /&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/iu), (part, i) =>
      i % 2 === 0 ? part : decodeEntity(`&${part};`, part)
    ),
    ""
  )

export const htmlText = (html: string): string =>
  pipe(
    html,
    EffectString.replaceAll(/<!--[\s\S]*?-->/gu, " "),
    EffectString.replaceAll(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/giu, " "),
    EffectString.replaceAll(/<[^>]+>/gu, " "),
    decodeEntities
  )

export const pdfText = (url: string, bytes: Uint8Array) =>
  Effect.tryPromise({
    try: () =>
      getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 })
        .then((pdf) => extractText(pdf, { mergePages: true }))
        .then((r) => r.text),
    catch: (cause) => new PageError({ url, message: `PDF: ${cause instanceof Error ? cause.message : String(cause)}` })
  })

export const normaliseText = (s: string): string =>
  pipe(
    s,
    EffectString.normalize("NFKC"),
    EffectString.toLowerCase,
    EffectString.replaceAll(/[‘’‚′]/gu, "'"),
    EffectString.replaceAll(/[“”„″]/gu, '"'),
    EffectString.replaceAll(/[‐-―−]/gu, "-"),
    EffectString.replaceAll(/[\s ​]+/gu, " "),
    EffectString.trim
  )

export const missingQuotes = (text: string, expect: ReadonlyArray<string>): ReadonlyArray<string> => {
  const haystack = normaliseText(text)

  return EffectArray.filter(expect, (quote) => !pipe(haystack, EffectString.includes(normaliseText(quote))))
}

const isPdf = (bytes: Uint8Array, contentType: string | undefined) =>
  contentType?.includes("application/pdf") === true ||
  (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)

const USER_AGENT = "Mozilla/5.0 (compatible; creditcards-earn-check)"

export const pageText = Effect.fn("pageText")(function* (url: string) {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.retryTransient({ schedule: Schedule.exponential("1 second"), times: 2 })
  )

  const response = yield* client
    .get(url, { headers: { "user-agent": USER_AGENT, accept: "text/html,application/pdf,*/*" } })
    .pipe(
      Effect.timeout("30 seconds"),
      Effect.mapError((cause) => new PageError({ url, message: String(cause) }))
    )

  if (response.status !== 200) return yield* new PageError({ url, message: `HTTP ${response.status}` })

  const bytes = new Uint8Array(
    yield* response.arrayBuffer.pipe(Effect.mapError((cause) => new PageError({ url, message: String(cause) })))
  )

  if (isPdf(bytes, response.headers["content-type"])) return yield* pdfText(url, bytes)

  return htmlText(new TextDecoder().decode(bytes))
})

export interface CheckResult {
  readonly card: string
  readonly url: string

  readonly missing: ReadonlyArray<string>

  readonly error?: string
}

export const checkEarnPages = Effect.fn("checkEarnPages")(function* (cards: ReadonlyMap<string, Card>) {
  const checks = EffectArray.flatMap([...cards], ([card, c]) =>
    c.status !== "discontinued"
      ? EffectArray.map(c.rewards?.earn_check ?? [], (check) => ({ card, url: check.url, expect: check.expect }))
      : []
  )

  const urls = [...new Set(EffectArray.map(checks, (c) => c.url))]

  const texts = new Map(
    yield* Effect.forEach(
      urls,
      (url) =>
        pageText(url).pipe(
          Effect.result,
          Effect.map((r) => [url, r] as const)
        ),
      { concurrency: 4 }
    )
  )

  const toCheckResult = ({ card, url, expect }: (typeof checks)[number]): CheckResult => {
    const text = required(texts.get(url))

    return Result.isFailure(text)
      ? { card, url, missing: [], error: text.failure.message }
      : { card, url, missing: missingQuotes(text.success, expect) }
  }

  return EffectArray.map(checks, (check) => toCheckResult(check))
})

export const formatCheck = (results: ReadonlyArray<CheckResult>): string => {
  const changed = EffectArray.filter(results, (r) => r.missing.length > 0)
  const failed = EffectArray.filter(results, (r) => r.error !== undefined)

  const lines = [
    `Issuer earn pages: ${results.length} checked, ${changed.length} changed, ${failed.length} unreadable.`,
    ""
  ]

  if (changed.length > 0) {
    lines.push(
      "These pages no longer contain the quoted earn wording. Re-read the page, update `rewards.earn` and",
      "`rewards.earn_check.expect` in the card's file, then `bun run cli rewards stamp <issuer/card>`.",
      ""
    )

    for (const r of changed) {
      lines.push(`- [ ] \`${r.card}\` — ${r.url}`, ...EffectArray.map(r.missing, (q) => `  - missing: "${q}"`))
    }

    lines.push("")
  }

  if (failed.length > 0)
    lines.push(
      "Unreadable (not checked this run):",
      ...EffectArray.map(failed, (r) => `- \`${r.card}\` — ${r.url}: ${r.error}`),
      ""
    )

  return EffectArray.join(lines, "\n")
}
