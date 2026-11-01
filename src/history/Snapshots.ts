import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { encodeJson } from "../util/json.ts"

export interface CdrSnapshot {
  readonly brand: string
  readonly version: number | null
  readonly product: unknown
}

export class SnapshotError extends Schema.TaggedError<SnapshotError>()("SnapshotError", {
  file: Schema.String,
  message: Schema.String
}) {}

const byKey = ([a]: readonly [string, unknown], [b]: readonly [string, unknown]) => (a < b ? -1 : a > b ? 1 : 0)

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((item: unknown) => sortKeys(item))

  if (value === null || typeof value !== "object") return value
  const sorted: Record<string, unknown> = {}

  for (const [key, item] of Object.entries(value).toSorted(byKey)) sorted[key] = sortKeys(item)

  return sorted
}

export const encodeSnapshot = (snapshot: CdrSnapshot): string =>
  `${encodeJson(sortKeys({ brand: snapshot.brand, version: snapshot.version, product: snapshot.product }), 2)}\n`

const SavedVersion = Schema.fromJsonString(Schema.Struct({ version: Schema.NullOr(Schema.Number) }))

const SNAPSHOT_FILE = /^\d{4}-\d{2}-\d{2}\.json$/u

export const productDir = (issuer: string, productId: string): string => {
  const safe = encodeURIComponent(productId)

  if (safe === "" || safe === "." || safe === "..") throw new Error(`Unsafe CDR product id: ${productId}`)

  return `${issuer}/${safe}`
}

export class Snapshots extends Context.Service<
  Snapshots,
  {
    record(
      issuer: string,
      productId: string,
      date: string,
      snapshot: CdrSnapshot
    ): Effect.Effect<boolean, SnapshotError>
  }
>()("creditcards/history/Snapshots") {
  static readonly layer = (historyDir: string) =>
    Layer.effect(
      Snapshots,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path

        const fail = (file: string) => (cause: unknown) =>
          new SnapshotError({ file, message: cause instanceof Error ? cause.message : String(cause) })

        const record = Effect.fn("Snapshots.record")(function* (
          issuer: string,
          productId: string,
          date: string,
          snapshot: CdrSnapshot
        ) {
          const dir = path.join(historyDir, "cdr", productDir(issuer, productId))
          const text = encodeSnapshot(snapshot)

          const existing = (yield* fs.exists(dir).pipe(Effect.mapError(fail(dir))))
            ? (yield* fs.readDirectory(dir).pipe(Effect.mapError(fail(dir)))).filter((n) => SNAPSHOT_FILE.test(n))
            : []

          const latest = existing.toSorted().at(-1)

          if (latest !== undefined) {
            const latestFile = path.join(dir, latest)
            const current = yield* fs.readFileString(latestFile).pipe(Effect.mapError(fail(latestFile)))

            const saved = yield* Schema.decodeUnknownEffect(SavedVersion)(current).pipe(
              Effect.mapError(fail(latestFile))
            )

            if (current === encodeSnapshot({ ...snapshot, version: saved.version })) return false
          }

          const file = path.join(dir, `${date}.json`)
          yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.mapError(fail(file)))
          yield* fs.writeFileString(file, text).pipe(Effect.mapError(fail(file)))

          return true
        })

        return Snapshots.of({ record })
      })
    )
}
