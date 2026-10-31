import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, Layer, Option, Path } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { FetchHttpClient } from "effect/http"
import { toApi, validate } from "./build/build.ts"
import { CdrClient } from "./cdr/CdrClient.ts"
import { checkEarnPages, formatCheck, normaliseText, pageText } from "./rewards/check.ts"
import { formatQueue, reviewQueue, stamp } from "./rewards/review.ts"
import { Store } from "./store/Store.ts"
import { summariseReport, summariseRewardsReview, syncCdr } from "./sync/Sync.ts"

const DATA_DIR = "data"

const writeFile = Effect.fnUntraced(function*(file: string, content: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs.makeDirectory(path.dirname(file), { recursive: true })
  yield* fs.writeFileString(file, content)
})

const sync = Command.make(
  "sync",
  {
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDescription("Report changes without writing"), Flag.withDefault(false)),
    reportDir: Flag.String("report-dir").pipe(Flag.withDescription("Where to write the sync report"), Flag.withDefault(".cache"))
  },
  Effect.fn(function*({ dryRun, reportDir }) {
    const report = yield* syncCdr({ dryRun })
    const summary = summariseReport(report)
    yield* writeFile(`${reportDir}/sync-report.json`, JSON.stringify(report, null, 2))
    yield* writeFile(`${reportDir}/sync-summary.md`, summary)
    yield* writeFile(`${reportDir}/rewards-review.md`, summariseRewardsReview(report))
    yield* Console.log(summary)
  })
).pipe(Command.withDescription("Pull CDR product data and update data/"))

const validateCommand = Command.make(
  "validate",
  {},
  Effect.fn(function*() {
    const dataset = yield* validate
    yield* Console.log(`OK: ${dataset.issuers.size} issuers, ${dataset.cards.size} cards, ${dataset.programs.size} programs`)
  })
).pipe(Command.withDescription("Validate every file in data/"))

const build = Command.make(
  "build",
  { out: Flag.String("out").pipe(Flag.withDefault("dist")) },
  Effect.fn(function*({ out }) {
    const dataset = yield* validate
    yield* writeFile(`${out}/api.json`, JSON.stringify(toApi(dataset)))
    yield* Console.log(`Wrote ${out}/api.json (${dataset.cards.size} cards)`)
  })
).pipe(Command.withDescription("Build dist/api.json from data/"))

const rewardsTodo = Command.make(
  "todo",
  {
    issuer: Flag.String("issuer").pipe(Flag.withDescription("Only this issuer"), Flag.optional),
    out: Flag.String("out").pipe(Flag.withDefault(".cache/rewards-todo.md"))
  },
  Effect.fn(function*({ issuer, out }) {
    const items = yield* reviewQueue(Option.getOrUndefined(issuer))
    const text = formatQueue(items)
    yield* writeFile(out, text)
    yield* Console.log(text)
    yield* Console.log(`Wrote ${out}`)
  })
).pipe(Command.withDescription("List cards whose earn rates need review, with their CDR loyalty text"))

const rewardsStamp = Command.make(
  "stamp",
  {
    cards: Argument.String("card").pipe(Argument.withDescription("issuer/card keys"), Argument.atLeast(1)),
    none: Flag.Boolean("none").pipe(Flag.withDescription("Record that the card has no fixed earn rate"), Flag.withDefault(false))
  },
  Effect.fn(function*({ cards, none }) {
    yield* stamp(cards, none)
  })
).pipe(Command.withDescription("Mark cards' earn rates as manually reviewed against the current CDR text"))

const rewardsCheck = Command.make(
  "check",
  {
    show: Flag.String("show").pipe(Flag.withDescription("Print the normalised text of one page, for picking quotes"), Flag.optional),
    reportDir: Flag.String("report-dir").pipe(Flag.withDescription("Where to write the report"), Flag.withDefault(".cache"))
  },
  Effect.fn(function*({ show, reportDir }) {
    if (Option.isSome(show)) return yield* Console.log(normaliseText(yield* pageText(show.value)))
    const results = yield* checkEarnPages((yield* (yield* Store).load).cards)
    const report = formatCheck(results)
    yield* writeFile(`${reportDir}/earn-check.json`, JSON.stringify(results, null, 2))
    yield* writeFile(`${reportDir}/earn-check.md`, report)
    yield* Console.log(report)
  })
).pipe(Command.withDescription("Check manual earn rates against the issuer pages in rewards.earn_check (report only)"))

const rewards = Command.make("rewards").pipe(
  Command.withDescription("Review earn rates the parser cannot read"),
  Command.withSubcommands([rewardsTodo, rewardsStamp, rewardsCheck])
)

const MainLayer = Layer.mergeAll(CdrClient.layer, Store.layer(DATA_DIR), FetchHttpClient.layer).pipe(
  Layer.provideMerge(BunServices.layer)
)

Command.make("creditcards").pipe(
  Command.withSubcommands([sync, validateCommand, build, rewards]),
  Command.run({ version: "0.1.0" }),
  Effect.provide(MainLayer),
  BunRuntime.runMain
)
