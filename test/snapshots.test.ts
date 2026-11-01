import { BunServices } from "@effect/platform-bun"
import { assert, describe, layer, test } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer, Path } from "effect"
import { encodeSnapshot, productDir, Snapshots } from "../src/history/Snapshots.ts"

class HistoryDir extends Context.Service<HistoryDir, string>()("test/HistoryDir") {}

const TempHistory = Layer.unwrap(
  Effect.gen(function* () {
    const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()

    return Layer.merge(Snapshots.layer(dir), Layer.succeed(HistoryDir, dir))
  })
).pipe(Layer.provideMerge(BunServices.layer))

const snapshot = (annualFee: number, version = 4) => ({
  brand: "Bank",
  version,
  product: { productId: "p", fees: [{ name: "Annual", amount: String(annualFee) }] }
})

const listed = Effect.fn("listed")(function* (productId: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = yield* HistoryDir

  return (yield* fs.readDirectory(path.join(dir, "cdr", "bank", productId))).toSorted()
})

describe("CDR snapshots", () => {
  layer(TempHistory)((it) => {
    it.effect("writes a file only when the product changes", () =>
      Effect.gen(function* () {
        const snapshots = yield* Snapshots
        assert.isTrue(yield* snapshots.record("bank", "p1", "2026-11-01", snapshot(99)))
        assert.isFalse(yield* snapshots.record("bank", "p1", "2026-11-02", snapshot(99)))
        assert.isTrue(yield* snapshots.record("bank", "p1", "2026-11-03", snapshot(129)))
        assert.deepStrictEqual(yield* listed("p1"), ["2026-11-01.json", "2026-11-03.json"])
      })
    )

    it.effect("ignores a different negotiated API version for the same product", () =>
      Effect.gen(function* () {
        const snapshots = yield* Snapshots
        yield* snapshots.record("bank", "p3", "2026-11-01", snapshot(99, 4))
        assert.isFalse(yield* snapshots.record("bank", "p3", "2026-11-02", snapshot(99, 3)))
        assert.isTrue(yield* snapshots.record("bank", "p3", "2026-11-03", snapshot(129, 3)))
        assert.deepStrictEqual(yield* listed("p3"), ["2026-11-01.json", "2026-11-03.json"])
      })
    )

    it.effect("keeps one file per day when the sync runs twice", () =>
      Effect.gen(function* () {
        const snapshots = yield* Snapshots
        yield* snapshots.record("bank", "p2", "2026-11-01", snapshot(99))
        yield* snapshots.record("bank", "p2", "2026-11-01", snapshot(129))
        assert.deepStrictEqual(yield* listed("p2"), ["2026-11-01.json"])
      })
    )
  })

  test("ignores key order so reordered responses are not changes", () => {
    assert.strictEqual(
      encodeSnapshot({ brand: "Bank", version: 4, product: { b: 1, a: { d: 2, c: 3 } } }),
      encodeSnapshot({ version: 4, product: { a: { c: 3, d: 2 }, b: 1 }, brand: "Bank" })
    )
  })

  test("rejects product ids that would escape the issuer folder", () => {
    assert.strictEqual(productDir("bank", "a/b"), "bank/a%2Fb")
    assert.throws(() => {
      productDir("bank", "..")
    })
  })
})
