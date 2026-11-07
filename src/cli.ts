import { Array as EffectArray, DateTime } from "effect"
import { provenanceCommand } from "./provenance/commands.ts"
import { heldCommand } from "./sync/heldCommand.ts"
import { encodeJson, encodePrettyJson, jsonEqual } from "./util/json.ts"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { FetchHttpClient } from "effect/http"
import { toApi, validate } from "./build/build.ts"
import { CdrClient } from "./cdr/CdrClient.ts"
import {
  type CheckResult,
  checkEarnPages,
  formatCheck,
  nextKnownBlocked,
  normaliseText,
  pageText
} from "./rewards/check.ts"
import {
  bonusReviewQueue,
  formatBonusQueue,
  formatQueue,
  RewardsError,
  reviewQueue,
  stamp,
  stampBonus
} from "./rewards/review.ts"
import { applyComment } from "./review/apply.ts"
import { metricsRecord, PreviousMetrics, reviewOpenCount, TaskPage, TaskReport, webhookItems } from "./review/tasks.ts"
import { ParsedComment } from "./review/commands.ts"
import { Snapshots } from "./history/Snapshots.ts"
import type { EarnCheck } from "./model/schema.ts"
import { splitCardKey, Store } from "./store/Store.ts"
import { summariseHolds, summariseReport, summariseRewardsReview, syncCdr } from "./sync/Sync.ts"
import { Digest } from "effect/crypto"

const DATA_DIR = "data"
const HISTORY_DIR = "history"

const writeFile = Effect.fn("writeFile")(function* (file: string, content: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs.makeDirectory(path.dirname(file), { recursive: true })
  yield* fs.writeFileString(file, content)
})

const sync = Command.make(
  "sync",
  {
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Report changes without writing"),
      Flag.withDefault(false)
    ),
    reportDir: Flag.String("report-dir").pipe(
      Flag.withDescription("Where to write the sync report"),
      Flag.withDefault(".cache")
    )
  },
  Effect.fn(function* ({ dryRun, reportDir }) {
    const report = yield* syncCdr({ dryRun })
    const summary = yield* summariseReport(report)
    yield* writeFile(`${reportDir}/sync-report.json`, yield* encodePrettyJson(report))
    yield* writeFile(`${reportDir}/sync-summary.md`, summary)
    yield* writeFile(`${reportDir}/rewards-review.md`, summariseRewardsReview(report))
    yield* writeFile(
      `${reportDir}/sync-held.md`,
      EffectArray.join([`Sync ${report.date}`, "", ...summariseHolds(report)], "\n")
    )
    yield* Console.log(summary)
  })
).pipe(Command.withDescription("Pull CDR product data and update data/"))

const validateCommand = Command.make(
  "validate",
  {},
  Effect.fn(function* () {
    const dataset = yield* validate
    yield* Console.log(
      `OK: ${dataset.issuers.size} issuers, ${dataset.cards.size} cards, ${dataset.programs.size} programs`
    )
  })
).pipe(Command.withDescription("Validate every file in data/"))

const build = Command.make(
  "build",
  { out: Flag.String("out").pipe(Flag.withDefault("dist")) },
  Effect.fn(function* ({ out }) {
    const validated = yield* validate
    const snapshots = yield* Snapshots
    const changes = new Map<string, string>()

    for (const [key, card] of validated.cards) {
      if (card.cdr === undefined) continue
      const changedOn = yield* snapshots.lastChanged(splitCardKey(key).issuer, card.cdr.product_id)

      if (changedOn !== undefined) changes.set(key, changedOn)
    }

    const dataset = { ...validated, changes }

    yield* writeFile(`${out}/api.json`, yield* encodeJson(toApi(dataset, DateTime.formatIso(yield* DateTime.now))))
    yield* Console.log(`Wrote ${out}/api.json (${dataset.cards.size} cards)`)
  })
).pipe(Command.withDescription("Build dist/api.json from data/"))

const rewardsTodo = Command.make(
  "todo",
  {
    issuer: Flag.String("issuer").pipe(Flag.withDescription("Only this issuer"), Flag.optional),
    out: Flag.String("out").pipe(Flag.withDefault(".cache/rewards-todo.md"))
  },
  Effect.fn(function* ({ issuer, out }) {
    const items = yield* reviewQueue(Option.getOrUndefined(issuer))
    const text = yield* formatQueue(items)
    yield* writeFile(out, text)
    yield* Console.log(text)
    yield* Console.log(`Wrote ${out}`)
  })
).pipe(Command.withDescription("List cards whose earn rates need review, with their CDR loyalty text"))

const rewardsStamp = Command.make(
  "stamp",
  {
    cards: Argument.String("card").pipe(
      Argument.withDescription("issuer/card keys, optionally with @hash from the review list"),
      Argument.atLeast(1)
    ),
    none: Flag.Boolean("none").pipe(
      Flag.withDescription("Record that the card has no fixed earn rate"),
      Flag.withDefault(false)
    )
  },
  Effect.fn(function* ({ cards, none }) {
    yield* stamp(cards, none)
  })
).pipe(Command.withDescription("Mark cards' earn rates as manually reviewed against the current CDR text"))

const bonusTodo = Command.make(
  "bonus-todo",
  {
    issuer: Flag.String("issuer").pipe(Flag.withDescription("Only this issuer"), Flag.optional),
    out: Flag.String("out").pipe(Flag.withDefault(".cache/bonus-todo.md"))
  },
  Effect.fn(function* ({ issuer, out }) {
    const text = yield* formatBonusQueue(yield* bonusReviewQueue(Option.getOrUndefined(issuer)))
    yield* writeFile(out, text)
    yield* Console.log(text)
    yield* Console.log(`Wrote ${out}`)
  })
).pipe(Command.withDescription("List cards whose signup bonuses need review, with their CDR bonus text"))

const bonusStamp = Command.make(
  "bonus-stamp",
  {
    cards: Argument.String("card").pipe(
      Argument.withDescription("issuer/card keys, optionally with @hash from the review list"),
      Argument.atLeast(1)
    ),
    none: Flag.Boolean("none").pipe(
      Flag.withDescription("Record that the card has no current points offer"),
      Flag.withDefault(false)
    )
  },
  Effect.fn(function* ({ cards, none }) {
    yield* stampBonus(cards, none)
  })
).pipe(Command.withDescription("Mark cards' signup bonuses as manually reviewed against the current CDR text"))

const recordBlockedCheck = Effect.fn("recordBlockedCheck")(function* (input: {
  readonly check: EarnCheck
  readonly results: ReadonlyArray<CheckResult>
  readonly key: string
  readonly date: string
}) {
  const { check, results, key, date } = input
  const result = EffectArray.findFirst(results, (r) => r.card === key && r.url === check.url)

  if (Option.isNone(result)) return check
  const { known_blocked: _blocked, ...rest } = check
  const known_blocked = yield* nextKnownBlocked({ result: result.value, blocked: check.known_blocked, date })

  return known_blocked === undefined ? rest : { ...rest, known_blocked }
})

const rewardsCheck = Command.make(
  "check",
  {
    recordBlocked: Flag.Boolean("record-blocked").pipe(Flag.withDefault(false)),
    show: Flag.String("show").pipe(
      Flag.withDescription("Print the normalised text of one page, for picking quotes"),
      Flag.optional
    ),
    reportDir: Flag.String("report-dir").pipe(
      Flag.withDescription("Where to write the report"),
      Flag.withDefault(".cache")
    )
  },
  Effect.fn(function* ({ show, reportDir, recordBlocked }) {
    if (Option.isSome(show)) return yield* Console.log(normaliseText(yield* pageText(show.value)))
    const store = yield* Store
    const { cards } = yield* store.load
    const results = yield* checkEarnPages(cards)

    if (recordBlocked) {
      const since = DateTime.formatIsoDate(yield* DateTime.now)

      for (const [key, card] of cards) {
        const checks = card.rewards?.earn_check

        if (checks === undefined || card.rewards === undefined) continue

        const updated = yield* Effect.forEach(checks, (check) =>
          recordBlockedCheck({ check, results, key, date: since })
        )

        if (!(yield* jsonEqual(updated, checks))) {
          const { issuer, card: slug } = splitCardKey(key)
          yield* store.writeCard(issuer, slug, { ...card, rewards: { ...card.rewards, earn_check: updated } })
        }
      }
    }

    const report = formatCheck(results)
    yield* writeFile(`${reportDir}/earn-check.json`, yield* encodePrettyJson(results))
    yield* writeFile(`${reportDir}/earn-check.md`, report)

    return yield* Console.log(report)
  })
).pipe(
  Command.withDescription(
    "Check manual earn rates against the issuer pages in rewards.earn_check (use --record-blocked to record, update and clear known blocks)"
  )
)

const rewards = Command.make("rewards").pipe(
  Command.withDescription("Review earn rates and signup bonuses the parsers cannot read"),
  Command.withSubcommands([rewardsTodo, rewardsStamp, bonusTodo, bonusStamp, rewardsCheck])
)

const reviewApply = Command.make(
  "apply",
  {
    bodyFile: Flag.String("body-file").pipe(Flag.withDescription("File holding the comment text")),
    by: Flag.String("by").pipe(Flag.withDescription("Login of the comment author")),
    url: Flag.String("url").pipe(Flag.withDescription("URL of the comment")),
    out: Flag.String("out").pipe(Flag.withDefault(".cache/review-result.md"))
  },
  Effect.fn(function* ({ bodyFile, by, url, out }) {
    const body = yield* (yield* FileSystem.FileSystem).readFileString(bodyFile)
    const result = yield* applyComment(body, { by, url })

    if (ParsedComment.$is("Invalid")(result)) {
      yield* writeFile(
        out,
        EffectArray.join(["Nothing applied:", ...EffectArray.map(result.errors, (error) => `- ${error}`)], "\n")
      )

      return yield* RewardsError.make({ message: EffectArray.join(result.errors, "; ") })
    }

    yield* writeFile(
      out,
      EffectArray.join(
        EffectArray.map(result.applied, (line) => `- ${line}`),
        "\n"
      )
    )

    return yield* Console.log(
      result.applied.length === 0 ? "No review commands" : EffectArray.join(result.applied, "\n")
    )
  })
).pipe(Command.withDescription("Apply /approve, /reject, /earn-none and /bonus-none commands from an issue comment"))

const readJsonFile = Effect.fn("readJsonFile")(function* <A, I>(schema: Schema.Codec<A, I>, file: string) {
  const fs = yield* FileSystem.FileSystem
  const text = (yield* fs.exists(file)) ? yield* fs.readFileString(file) : "null"

  return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text)
})

const reviewTasks = Command.make(
  "tasks",
  {
    report: Flag.String("report").pipe(Flag.withDefault(".cache/sync-report.json")),
    pages: Flag.String("pages").pipe(Flag.withDefault(".cache/earn-check.json")),
    previous: Flag.String("previous").pipe(Flag.withDefault(".cache/previous-metrics.json")),
    outcomes: Flag.String("outcomes").pipe(Flag.withDefault("{}")),
    run: Flag.String("run").pipe(Flag.withDefault("")),
    date: Flag.String("date").pipe(Flag.optional),
    out: Flag.String("out").pipe(Flag.withDefault(".cache/review-tasks.json"))
  },
  Effect.fn(function* ({ report, pages, previous, outcomes, run, date, out }) {
    const syncReport = yield* readJsonFile(Schema.NullOr(TaskReport), report)
    const pageResults = yield* readJsonFile(Schema.NullOr(Schema.Array(TaskPage)), pages)
    const previousMetrics = (yield* readJsonFile(Schema.NullOr(PreviousMetrics), previous)) ?? {}

    const stepOutcomes = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)))(
      outcomes
    )

    const today = Option.getOrElse(date, () => DateTime.formatIsoDateUtc(DateTime.nowUnsafe()))
    const queue = { report: syncReport ?? {}, pages: pageResults ?? [] }

    const metrics = yield* metricsRecord({
      report: syncReport,
      pages: pageResults,
      previous: previousMetrics,
      outcomes: stepOutcomes,
      run,
      date: today
    })

    yield* writeFile(out, yield* encodeJson({ open: reviewOpenCount(queue), webhook: webhookItems(queue), metrics }))
  })
).pipe(
  Command.withDescription(
    "Work out the open human review tasks from a sync report and earn page check (for the issues, webhook and metrics)"
  )
)

const review = Command.make("review").pipe(
  Command.withDescription("Apply review decisions written as issue comment commands"),
  Command.withSubcommands([reviewApply, reviewTasks])
)

const MainLayer = Layer.mergeAll(
  CdrClient.layer,
  Store.layer(DATA_DIR),
  Snapshots.layer(HISTORY_DIR),
  FetchHttpClient.layer,
  Digest.layerWebCrypto
).pipe(Layer.provideMerge(BunServices.layer))

Command.make("creditcards").pipe(
  Command.withSubcommands([sync, validateCommand, build, rewards, provenanceCommand, heldCommand, review]),
  Command.run({ version: "0.1.0" }),
  Effect.provide(MainLayer),
  (program) => {
    BunRuntime.runMain(program)
  }
)
