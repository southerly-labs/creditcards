import { assert, test } from "@effect/vitest"
import { Schema } from "effect"

const lintReport = Schema.fromJsonString(
  Schema.Struct({
    diagnostics: Schema.Array(Schema.Struct({ code: Schema.String, severity: Schema.String }))
  })
)

const lintSource = async (source: string) => {
  const file = `/tmp/creditcards-lint-${crypto.randomUUID()}.ts`
  await Bun.write(file, source)

  try {
    const result = Bun.spawnSync({
      cmd: ["./node_modules/.bin/oxlint", "-c", ".oxlintrc.json", "--format", "json", file]
    })

    const report = Schema.decodeUnknownSync(lintReport)(result.stdout.toString())

    return { exitCode: result.exitCode, diagnostics: report.diagnostics }
  } finally {
    await Bun.file(file).delete()
  }
}

test("the vendored anti-slop plugin rejects Reflect indirection", async () => {
  const result = await lintSource('export const value = Reflect.get({ value: 1 }, "value")\n')
  assert.notStrictEqual(result.exitCode, 0)
  assert.isTrue(
    result.diagnostics.some(
      (diagnostic) => diagnostic.code === "anti-slop(no-reflect-get)" && diagnostic.severity === "error"
    )
  )
})

test("the existing Effect plugin remains active beside anti-slop", async () => {
  const result = await lintSource(
    'import { Effect } from "effect"\nexport const operation = Effect.fnUntraced(function* () { yield* Effect.void })\n'
  )

  assert.notStrictEqual(result.exitCode, 0)
  assert.isTrue(result.diagnostics.some((diagnostic) => diagnostic.code === "effect(no-effect-fn-untraced)"))
})

test("the anti-slop Effect plugin rejects manual tagged construction", async () => {
  const result = await lintSource('export const state = { _tag: "Ready", value: 1 }\n')
  assert.notStrictEqual(result.exitCode, 0)
  assert.isTrue(
    result.diagnostics.some((diagnostic) => diagnostic.code === "anti-slop-effect(no-manual-tagged-construction)")
  )
})

test("anti-slop rejects adjacent eager array passes", async () => {
  const result = await lintSource(
    "export const values = [1, 2].filter((value) => value > 0).map((value) => value * 2)\n"
  )

  assert.notStrictEqual(result.exitCode, 0)
  assert.isTrue(result.diagnostics.some((diagnostic) => diagnostic.code === "anti-slop(no-array-filter-map)"))
})

test("the local Oxlint rule rejects code comments", async () => {
  const result = await lintSource("// explanation\nexport const value = 1\n")
  assert.notStrictEqual(result.exitCode, 0)
  assert.isTrue(
    result.diagnostics.some(
      (diagnostic) => diagnostic.code === "project(no-code-comments)" && diagnostic.severity === "error"
    )
  )
})

test("non-const assertions need an invariant outside the isolated utility", async () => {
  const result = await lintSource("export const date = {} as Date\n")
  assert.notStrictEqual(result.exitCode, 0)
  assert.isTrue(
    result.diagnostics.some((diagnostic) => diagnostic.code === "anti-slop(require-safety-comment-for-type-assertion)")
  )
})
