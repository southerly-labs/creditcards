import { assert, describe, test } from "@effect/vitest"
import { ParsedComment, parseComment, ReviewCommand } from "../src/review/commands.ts"

const commands = (body: string) => {
  const parsed = parseComment(body)

  return ParsedComment.$is("Commands")(parsed) ? parsed.commands : []
}

const errors = (body: string) => {
  const parsed = parseComment(body)

  return ParsedComment.$is("Invalid")(parsed) ? parsed.errors : []
}

describe("review commands in issue comments", () => {
  test("reads one command per line and ignores other text", () => {
    assert.deepStrictEqual(
      commands(
        [
          "Looked at these:",
          "/approve 0123456789ab",
          "/reject abcdef012345 text unchanged, parser misread it",
          "/earn-none anz/rewards `nab/low-fee-card`",
          "/bonus-none westpac/altitude-black"
        ].join("\n")
      ),
      [
        ReviewCommand.Approve({ id: "0123456789ab", note: "" }),
        ReviewCommand.Reject({ id: "abcdef012345", note: "text unchanged, parser misread it" }),
        ReviewCommand.EarnNone({ cards: ["anz/rewards", "nab/low-fee-card"] }),
        ReviewCommand.BonusNone({ cards: ["westpac/altitude-black"] })
      ]
    )
  })

  test("a comment without commands parses to none", () => {
    assert.deepStrictEqual(commands("Thanks, will look tomorrow. See a/b"), [])
  })

  test("rejects the whole comment when any command is wrong", () => {
    const found = errors("/approve 0123456789ab\n/reject 0123456789ab\n/approve nope\n/earn-none ../x\n/frobnicate")

    assert.strictEqual(found.length, 4)
    assert.include(found[0], "say why")
    assert.include(found[1], "12-character hold id")
    assert.include(found[2], "not an issuer/card key")
    assert.include(found[3], "unknown command")
  })
})
