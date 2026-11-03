import { BunServices } from "@effect/platform-bun"
import { assert, layer } from "@effect/vitest"
import { Effect, FileSystem, Schema, Array as EffectArray } from "effect"

const lintReport = Schema.fromJsonString(
  Schema.Struct({
    diagnostics: Schema.Array(Schema.Struct({ code: Schema.String, severity: Schema.String }))
  })
)

const lintSource = Effect.fn("lintSource")(function* (source: string) {
  const fs = yield* FileSystem.FileSystem
  const file = yield* fs.makeTempFileScoped({ prefix: "creditcards-lint-", suffix: ".ts" })

  yield* fs.writeFileString(file, source)

  const result = Bun.spawnSync({
    cmd: ["./node_modules/.bin/oxlint", "-c", ".oxlintrc.json", "--format", "json", file]
  })

  const report = yield* Schema.decodeEffect(lintReport)(result.stdout.toString())

  return { exitCode: result.exitCode, diagnostics: report.diagnostics }
})

layer(BunServices.layer)((it) => {
  it.effect("the vendored anti-slop plugin rejects Reflect indirection", () =>
    Effect.gen(function* () {
      const result = yield* lintSource('export const value = Reflect.get({ value: 1 }, "value")\n')
      assert.notStrictEqual(result.exitCode, 0)
      assert.isTrue(
        EffectArray.some(
          result.diagnostics,
          (diagnostic) => diagnostic.code === "anti-slop(no-reflect-get)" && diagnostic.severity === "error"
        )
      )
    })
  )

  it.effect("the existing Effect plugin remains active beside anti-slop", () =>
    Effect.gen(function* () {
      const result = yield* lintSource(
        'import { Effect } from "effect"\nexport const operation = Effect.fnUntraced(function* () { yield* Effect.void })\n'
      )

      assert.notStrictEqual(result.exitCode, 0)
      assert.isTrue(
        EffectArray.some(result.diagnostics, (diagnostic) => diagnostic.code === "effect(no-effect-fn-untraced)")
      )
    })
  )

  it.effect("the anti-slop Effect plugin rejects manual tagged construction", () =>
    Effect.gen(function* () {
      const result = yield* lintSource('export const state = { _tag: "Ready", value: 1 }\n')
      assert.notStrictEqual(result.exitCode, 0)
      assert.isTrue(
        EffectArray.some(
          result.diagnostics,
          (diagnostic) => diagnostic.code === "anti-slop-effect(no-manual-tagged-construction)"
        )
      )
    })
  )

  it.effect("anti-slop rejects adjacent eager array passes", () =>
    Effect.gen(function* () {
      const result = yield* lintSource(
        "export const values = [1, 2].filter((value) => value > 0).map((value) => value * 2)\n"
      )

      assert.notStrictEqual(result.exitCode, 0)
      assert.isTrue(
        EffectArray.some(result.diagnostics, (diagnostic) => diagnostic.code === "anti-slop(no-array-filter-map)")
      )
    })
  )

  it.effect("the local Oxlint rule rejects code comments", () =>
    Effect.gen(function* () {
      const result = yield* lintSource("// explanation\nexport const value = 1\n")
      assert.notStrictEqual(result.exitCode, 0)
      assert.isTrue(
        EffectArray.some(
          result.diagnostics,
          (diagnostic) => diagnostic.code === "project(no-code-comments)" && diagnostic.severity === "error"
        )
      )
    })
  )

  it.effect("non-const assertions need an invariant outside the isolated utility", () =>
    Effect.gen(function* () {
      const result = yield* lintSource("export const date = {} as Date\n")
      assert.notStrictEqual(result.exitCode, 0)
      assert.isTrue(
        EffectArray.some(
          result.diagnostics,
          (diagnostic) => diagnostic.code === "anti-slop(require-safety-comment-for-type-assertion)"
        )
      )
    })
  )
})
