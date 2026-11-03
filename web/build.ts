import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, Schema, Array as EffectArray } from "effect"

class BuildFailed extends Schema.TaggedError<BuildFailed, { readonly brand: unique symbol }>()("BuildFailed", {
  messages: Schema.Array(Schema.String)
}) {}

const build = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem

  yield* fs.remove("dist/assets", { recursive: true, force: true })

  const result = yield* Effect.promise(() =>
    Bun.build({
      entrypoints: ["web/index.html", "web/table.html"],
      outdir: "dist",
      minify: true,
      splitting: true,

      naming: { chunk: "assets/[name]-[hash].[ext]", asset: "assets/[name]-[hash].[ext]" }
    })
  )

  if (!result.success) {
    yield* Effect.forEach(result.logs, (log) => Console.error(log))

    return yield* BuildFailed.make({ messages: EffectArray.map(result.logs, (log) => log.message) })
  }

  yield* fs.writeFileString(
    "dist/_headers",
    `/assets/*
  Cache-Control: public, max-age=31536000, immutable
`
  )

  return yield* Console.log(`Wrote ${result.outputs.length} site files to dist/`)
})

BunRuntime.runMain(build.pipe(Effect.provide(BunServices.layer)))
