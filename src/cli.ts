import { Clock } from "effect"
import { provenanceCommand } from "./provenance/commands.ts"
import { heldCommand } from "./sync/heldCommand.ts"
import { encodeJson } from "./util/json.ts"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, Layer, Option, Path } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { FetchHttpClient } from "effect/http"
import { toApi, validate } from "./build/build.ts"
import { CdrClient } from "./cdr/CdrClient.ts"
import { checkEarnPages, formatCheck, normaliseText, pageText } from "./rewards/check.ts"
import { bonusReviewQueue, formatBonusQueue, formatQueue, reviewQueue, stamp, stampBonus } from "./rewards/review.ts"
import { Snapshots } from "./history/Snapshots.ts"
import { splitCardKey, Store } from "./store/Store.ts"
import { summariseHolds, summariseReport, summariseRewardsReview, syncCdr } from "./sync/Sync.ts"

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
    const summary = summariseReport(report)
    yield* writeFile(`${reportDir}/sync-report.json`, encodeJson(report, 2))
    yield* writeFile(`${reportDir}/sync-summary.md`, summary)
    yield* writeFile(`${reportDir}/rewards-review.md`, summariseRewardsReview(report))
    yield* writeFile(`${reportDir}/sync-held.md`, [`Sync ${report.date}`, "", ...summariseHolds(report)].join("\n"))
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
      if (!card.cdr) continue
      const changedOn = yield* snapshots.lastChanged(splitCardKey(key).issuer, card.cdr.product_id)

      if (changedOn !== undefined) changes.set(key, changedOn)
    }

    const dataset = { ...validated, changes }

    yield* writeFile(
      `${out}/api.json`,
      encodeJson(toApi(dataset, new Date(yield* Clock.currentTimeMillis).toISOString()))
    )
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
    const text = formatBonusQueue(yield* bonusReviewQueue(Option.getOrUndefined(issuer)))
    yield* writeFile(out, text)
    yield* Console.log(text)
    yield* Console.log(`Wrote ${out}`)
  })
).pipe(Command.withDescription("List cards whose signup bonuses need review, with their CDR bonus text"))

const bonusStamp = Command.make(
  "bonus-stamp",
  {
    cards: Argument.String("card").pipe(Argument.withDescription("issuer/card keys"), Argument.atLeast(1)),
    none: Flag.Boolean("none").pipe(
      Flag.withDescription("Record that the card has no current points offer"),
      Flag.withDefault(false)
    )
  },
  Effect.fn(function* ({ cards, none }) {
    yield* stampBonus(cards, none)
  })
).pipe(Command.withDescription("Mark cards' signup bonuses as manually reviewed against the current CDR text"))

const rewardsCheck = Command.make(
  "check",
  {
    show: Flag.String("show").pipe(
      Flag.withDescription("Print the normalised text of one page, for picking quotes"),
      Flag.optional
    ),
    reportDir: Flag.String("report-dir").pipe(
      Flag.withDescription("Where to write the report"),
      Flag.withDefault(".cache")
    )
  },
  Effect.fn(function* ({ show, reportDir }) {
    if (Option.isSome(show)) return yield* Console.log(normaliseText(yield* pageText(show.value)))
    const results = yield* checkEarnPages((yield* (yield* Store).load).cards)
    const report = formatCheck(results)
    yield* writeFile(`${reportDir}/earn-check.json`, encodeJson(results, 2))
    yield* writeFile(`${reportDir}/earn-check.md`, report)

    return yield* Console.log(report)
  })
).pipe(Command.withDescription("Check manual earn rates against the issuer pages in rewards.earn_check (report only)"))

const rewards = Command.make("rewards").pipe(
  Command.withDescription("Review earn rates and signup bonuses the parsers cannot read"),
  Command.withSubcommands([rewardsTodo, rewardsStamp, bonusTodo, bonusStamp, rewardsCheck])
)

const MainLayer = Layer.mergeAll(
  CdrClient.layer,
  Store.layer(DATA_DIR),
  Snapshots.layer(HISTORY_DIR),
  FetchHttpClient.layer
).pipe(Layer.provideMerge(BunServices.layer))

Command.make("creditcards").pipe(
  Command.withSubcommands([sync, validateCommand, build, rewards, provenanceCommand, heldCommand]),
  Command.run({ version: "0.1.0" }),
  Effect.provide(MainLayer),
  (program) => {
    BunRuntime.runMain(program)
  }
)
