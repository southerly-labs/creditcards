import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, Layer, Path } from "effect"
import { Command, Flag } from "effect/cli"
import { toApi, validate } from "./build/build.ts"
import { CdrClient } from "./cdr/CdrClient.ts"
import { Store } from "./store/Store.ts"
import { summariseReport, syncCdr } from "./sync/Sync.ts"

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

const MainLayer = Layer.mergeAll(CdrClient.layer, Store.layer(DATA_DIR)).pipe(
  Layer.provideMerge(BunServices.layer)
)

Command.make("creditcards").pipe(
  Command.withSubcommands([sync, validateCommand, build]),
  Command.run({ version: "0.1.0" }),
  Effect.provide(MainLayer),
  BunRuntime.runMain
)
