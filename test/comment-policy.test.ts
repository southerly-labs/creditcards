import { BunServices } from "@effect/platform-bun"
import { assert, layer } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import { findCodeComments } from "../tools/oxlint/local/comment-policy.ts"

const comments = (source: string) => findCodeComments("fixture.ts", source)

layer(BunServices.layer)((it) => {
  it.effect("the parser rejects line, block, JSDoc and suppression comments", () =>
    Effect.gen(function* () {
      assert.lengthOf(yield* comments("// explanation\nexport const value = 1"), 1)
      assert.lengthOf(yield* comments("export const value = /* explanation */ 1"), 1)
      assert.lengthOf(yield* comments("/** documentation */\nexport const value = 1"), 1)
      assert.lengthOf(yield* comments("/* oxlint-disable */\nexport const value = 1"), 1)
      assert.lengthOf(yield* comments("// @ts-ignore\nexport const value = 1"), 1)
      assert.lengthOf(yield* findCodeComments("fixture.tsx", "export const view = <div>{/* explanation */}</div>"), 1)
      assert.lengthOf(yield* comments("export const text = `${/* explanation */ 1}`"), 1)
    })
  )

  it.effect("comment-like strings, URLs, regexes, templates and shebangs remain valid", () =>
    Effect.gen(function* () {
      assert.isEmpty(yield* comments('export const url = "https://example.com"'))
      assert.isEmpty(yield* comments('export const text = "/* literal */ // literal"'))
      assert.isEmpty(yield* comments("export const pattern = /https?:\\/\\//u"))
      assert.isEmpty(yield* comments("export const text = `<!-- literal --> /* literal */`"))
      assert.isEmpty(yield* comments("#!/usr/bin/env bun\nexport const value = 1"))
    })
  )

  it.effect("CSS comment checks preserve strings, escapes and URL tokens", () =>
    Effect.gen(function* () {
      assert.lengthOf(yield* findCodeComments("fixture.css", "a { /* explanation */ color: red }"), 1)
      assert.lengthOf(yield* findCodeComments("fixture.css", "a { color: red } /* unfinished"), 1)
      assert.isEmpty(yield* findCodeComments("fixture.css", 'a::after { content: "/* literal */" }'))
      assert.isEmpty(yield* findCodeComments("fixture.css", 'a { background: url("https://example.com/*literal*/") }'))
      assert.isEmpty(yield* findCodeComments("fixture.css", "a { background: url(https://example.com/*literal*/) }"))
    })
  )

  it.effect("HTML comment checks use the HTML parser", () =>
    Effect.gen(function* () {
      assert.lengthOf(yield* findCodeComments("fixture.html", "<div><!-- explanation --><p>Text</p></div>"), 1)
      assert.isEmpty(yield* findCodeComments("fixture.html", '<div data-text="<!-- literal -->">Text</div>'))
      assert.isEmpty(yield* findCodeComments("fixture.html", '<script>const text = "<!-- literal -->"</script>'))
    })
  )

  it.effect("the standalone check rejects a comment that disables its own lint rule", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const file = yield* fs.makeTempFileScoped({ prefix: "creditcards-comments-", suffix: ".ts" })

      yield* fs.writeFileString(file, "/* oxlint-disable project/no-code-comments */\nexport const value = 1\n")

      const result = Bun.spawnSync({ cmd: ["bun", "run", "comments:check", file] })
      assert.notStrictEqual(result.exitCode, 0)
      assert.include(result.stderr.toString(), "Code comments are forbidden")
    })
  )
})
