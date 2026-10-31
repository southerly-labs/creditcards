import { assert, test } from "@effect/vitest"
import { findCodeComments } from "../tools/oxlint/local/comment-policy.ts"

const comments = (source: string) => findCodeComments("fixture.ts", source)

test("the parser rejects line, block, JSDoc and suppression comments", async () => {
  assert.lengthOf(await comments("// explanation\nexport const value = 1"), 1)
  assert.lengthOf(await comments("export const value = /* explanation */ 1"), 1)
  assert.lengthOf(await comments("/** documentation */\nexport const value = 1"), 1)
  assert.lengthOf(await comments("/* oxlint-disable */\nexport const value = 1"), 1)
  assert.lengthOf(await comments("// @ts-ignore\nexport const value = 1"), 1)
  assert.lengthOf(await findCodeComments("fixture.tsx", "export const view = <div>{/* explanation */}</div>"), 1)
  assert.lengthOf(await comments("export const text = `${/* explanation */ 1}`"), 1)
})

test("comment-like strings, URLs, regexes, templates and shebangs remain valid", async () => {
  assert.isEmpty(await comments('export const url = "https://example.com"'))
  assert.isEmpty(await comments('export const text = "/* literal */ // literal"'))
  assert.isEmpty(await comments("export const pattern = /https?:\\/\\//u"))
  assert.isEmpty(await comments("export const text = `<!-- literal --> /* literal */`"))
  assert.isEmpty(await comments("#!/usr/bin/env bun\nexport const value = 1"))
})

test("CSS comment checks preserve strings, escapes and URL tokens", async () => {
  assert.lengthOf(await findCodeComments("fixture.css", "a { /* explanation */ color: red }"), 1)
  assert.lengthOf(await findCodeComments("fixture.css", "a { color: red } /* unfinished"), 1)
  assert.isEmpty(await findCodeComments("fixture.css", 'a::after { content: "/* literal */" }'))
  assert.isEmpty(await findCodeComments("fixture.css", 'a { background: url("https://example.com/*literal*/") }'))
  assert.isEmpty(await findCodeComments("fixture.css", "a { background: url(https://example.com/*literal*/) }"))
})

test("HTML comment checks use the HTML parser", async () => {
  assert.lengthOf(await findCodeComments("fixture.html", "<div><!-- explanation --><p>Text</p></div>"), 1)
  assert.isEmpty(await findCodeComments("fixture.html", '<div data-text="<!-- literal -->">Text</div>'))
  assert.isEmpty(await findCodeComments("fixture.html", '<script>const text = "<!-- literal -->"</script>'))
})

test("the standalone check rejects a comment that disables its own lint rule", async () => {
  const file = `/tmp/creditcards-comments-${crypto.randomUUID()}.ts`
  await Bun.write(file, "/* oxlint-disable project/no-code-comments */\nexport const value = 1\n")

  try {
    const result = Bun.spawnSync({ cmd: ["bun", "run", "comments:check", file] })
    assert.notStrictEqual(result.exitCode, 0)
    assert.include(result.stderr.toString(), "Code comments are forbidden")
  } finally {
    await Bun.file(file).delete()
  }
})
