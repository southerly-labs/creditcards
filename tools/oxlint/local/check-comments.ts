import { findCodeComments } from "./comment-policy.ts"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, Array as EffectArray, String as EffectString, pipe } from "effect"

const roots = ["src", "web", "test", "tools"]
const extensions = "**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx,css,html}"
const requested = process.argv.slice(2)

const files =
  requested.length > 0
    ? requested
    : EffectArray.filter(
        [
          ...new Bun.Glob("*.{js,cjs,mjs,jsx,ts,cts,mts,tsx,css,html}").scanSync({ onlyFiles: true, dot: true }),
          ...EffectArray.flatMap(roots, (root) =>
            EffectArray.map(
              [...new Bun.Glob(extensions).scanSync({ cwd: root, onlyFiles: true })],
              (file) => `${root}/${file}`
            )
          )
        ],
        (file) => !pipe(file, EffectString.startsWith("tools/oxlint/anti-slop/"))
      )

const checkFile = Effect.fn("checkFile")(function* (file: string) {
  const source = yield* (yield* FileSystem.FileSystem).readFileString(file)
  const comments = yield* findCodeComments(file, source)

  return EffectArray.map(
    comments,
    (comment) =>
      `${file}:${EffectString.split(pipe(source, EffectString.slice(0, comment.start)), "\n").length}: Code comments are forbidden; use documentation or meaningful names.`
  )
})

const program = Effect.gen(function* () {
  const reports = yield* Effect.forEach(files, checkFile, { concurrency: "unbounded" })

  yield* Effect.forEach(EffectArray.flatten(reports), (message) => Console.error(message))

  if (EffectArray.some(reports, (report) => report.length > 0)) process.exitCode = 1
})

BunRuntime.runMain(program.pipe(Effect.provide(BunServices.layer)))
