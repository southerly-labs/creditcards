import { required } from "../util/required.ts"
import { DateTime, Effect, Result, Schedule, Schema, Array as EffectArray, String as EffectString, pipe } from "effect"
import { HttpClient } from "effect/http"
import { extractText, getDocumentProxy } from "unpdf"
import type { Card, EarnCheck } from "../model/schema.ts"
import { isDelisted } from "../model/lifecycle.ts"
import { knownBlockedOf, PageEvent, pageAttention, pageStateOf, stepPage } from "../machine/blockedPage.ts"
import { dual } from "effect/Function"

export class PageError extends Schema.TaggedError<PageError, { readonly brand: unique symbol }>()("PageError", {
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

export const pdfText = dual<
  (bytes: Uint8Array) => (url: string) => Effect.Effect<string, PageError>,
  (url: string, bytes: Uint8Array) => Effect.Effect<string, PageError>
>(2, (url: string, bytes: Uint8Array): Effect.Effect<string, PageError> =>
  Effect.tryPromise({
    try: () =>
      getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 })
        .then((pdf) => extractText(pdf, { mergePages: true }))
        .then((r) => r.text),
    catch: (cause) => PageError.make({ url, message: `PDF: ${cause instanceof Error ? cause.message : String(cause)}` })
  })
)

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

const missingQuotesImpl = (text: string, expect: ReadonlyArray<string>): ReadonlyArray<string> => {
  const haystack = normaliseText(text)

  return EffectArray.filter(expect, (quote) => !pipe(haystack, EffectString.includes(normaliseText(quote))))
}

export const missingQuotes = dual<
  (expect: ReadonlyArray<string>) => (text: string) => ReadonlyArray<string>,
  (text: string, expect: ReadonlyArray<string>) => ReadonlyArray<string>
>(2, missingQuotesImpl)

const isPdf = (bytes: Uint8Array, contentType: string | undefined) =>
  (contentType !== undefined && pipe(contentType, EffectString.includes("application/pdf"))) ||
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
      Effect.mapError((cause) => PageError.make({ url, message: String(cause) }))
    )

  if (response.status !== 200) {
    const challenge = response.headers["cf-mitigated"]
    const evidence = `HTTP ${response.status}${challenge === undefined ? "" : `; cf-mitigated: ${challenge}`}`

    return yield* PageError.make({ url, message: evidence })
  }

  const bytes = new Uint8Array(
    yield* response.arrayBuffer.pipe(Effect.mapError((cause) => PageError.make({ url, message: String(cause) })))
  )

  if (isPdf(bytes, response.headers["content-type"])) return yield* pdfText(url, bytes)

  return htmlText(new TextDecoder().decode(bytes))
})

export interface CheckResult {
  readonly card: string
  readonly url: string

  readonly missing: ReadonlyArray<string>

  readonly error?: string
  readonly known_blocked?: EarnCheck["known_blocked"]
  readonly attention?: string
}

const pageEvent = (result: Pick<CheckResult, "error">, date: string): PageEvent =>
  result.error === undefined || result.error === ""
    ? PageEvent.cases.Read.make({})
    : PageEvent.cases.Failed.make({ error: result.error, date })

export const nextKnownBlocked = Effect.fn("nextKnownBlocked")(function* (input: {
  readonly result: Pick<CheckResult, "error">
  readonly blocked: EarnCheck["known_blocked"]
  readonly date: string
}) {
  return knownBlockedOf(yield* stepPage(pageStateOf(input.blocked), pageEvent(input.result, input.date)))
})

export const classifyCheck = Effect.fn("classifyCheck")(function* (input: {
  readonly result: CheckResult
  readonly blocked: EarnCheck["known_blocked"]
  readonly date: string
}) {
  const { result, blocked, date } = input

  if (blocked === undefined) return result
  const previous = pageStateOf(blocked)
  const attention = pageAttention(previous, yield* stepPage(previous, pageEvent(result, date)), date)

  return { ...result, known_blocked: blocked, ...(attention === undefined ? {} : { attention }) } satisfies CheckResult
})

export const needsPageReview = (result: CheckResult): boolean =>
  result.missing.length > 0 ||
  result.attention !== undefined ||
  (result.error !== undefined && result.known_blocked === undefined)

export const checkEarnPages = Effect.fn("checkEarnPages")(function* (cards: ReadonlyMap<string, Card>) {
  const date = DateTime.formatIsoDate(yield* DateTime.now)

  const checks = EffectArray.flatMap([...cards], ([card, c]) =>
    !isDelisted(c)
      ? EffectArray.map(c.rewards?.earn_check ?? [], (check) => ({
          card,
          url: check.url,
          expect: check.expect,
          blocked: check.known_blocked
        }))
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

  const toCheckResult = ({ card, url, expect, blocked }: (typeof checks)[number]) => {
    const text = required(texts.get(url))

    const result = Result.isFailure(text)
      ? { card, url, missing: [], error: text.failure.message }
      : { card, url, missing: missingQuotes(text.success, expect) }

    return classifyCheck({ result, blocked, date })
  }

  return yield* Effect.forEach(checks, (check) => toCheckResult(check))
})

export const formatCheck = (results: ReadonlyArray<CheckResult>): string => {
  const changed = EffectArray.filter(results, (r) => r.missing.length > 0)
  const failed = EffectArray.filter(results, (r) => r.error !== undefined && r.known_blocked === undefined)
  const blocked = EffectArray.filter(results, (r) => r.known_blocked !== undefined)

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

  if (blocked.length > 0)
    lines.push(
      "Standing known-blocked sources (quotes retained; checked on every run):",
      ...EffectArray.map(
        blocked,
        (r) =>
          `- \`${r.card}\` — ${r.url}: ${r.known_blocked?.reason}; ${r.error ?? "readable"}; since ${r.known_blocked?.since}${r.attention === undefined ? "" : ` — ACTION: ${r.attention}`}`
      ),
      ""
    )

  return EffectArray.join(lines, "\n")
}
