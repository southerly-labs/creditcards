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

const Saved = Schema.fromJsonString(Schema.Struct({ brand: Schema.String, product: Schema.Unknown }))

const byEncoding = (a: unknown, b: unknown) => {
  const [x, y] = [encodeJson(a), encodeJson(b)]

  return x < y ? -1 : x > y ? 1 : 0
}

const canonical = (value: unknown, skip: ReadonlySet<string> = new Set()): unknown => {
  if (Array.isArray(value)) return value.map((item: unknown) => canonical(item)).toSorted(byEncoding)

  if (value === null || typeof value !== "object") return value
  const result: Record<string, unknown> = {}

  for (const [key, item] of Object.entries(value).toSorted(byKey)) if (!skip.has(key)) result[key] = canonical(item)

  return result
}

const VOLATILE = new Set(["lastUpdated"])

export const sameProduct = (a: CdrSnapshot, b: Pick<CdrSnapshot, "brand" | "product">): boolean =>
  a.brand === b.brand && encodeJson(canonical(a.product, VOLATILE)) === encodeJson(canonical(b.product, VOLATILE))

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
    lastChanged(issuer: string, productId: string): Effect.Effect<string | undefined, SnapshotError>
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

            const saved = yield* Schema.decodeUnknownEffect(Saved)(current).pipe(Effect.mapError(fail(latestFile)))

            if (sameProduct(snapshot, saved)) return false
          }

          const file = path.join(dir, `${date}.json`)
          yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.mapError(fail(file)))
          yield* fs.writeFileString(file, text).pipe(Effect.mapError(fail(file)))

          return true
        })

        const lastChanged = Effect.fn("Snapshots.lastChanged")(function* (issuer: string, productId: string) {
          const dir = path.join(historyDir, "cdr", productDir(issuer, productId))

          if (!(yield* fs.exists(dir).pipe(Effect.mapError(fail(dir))))) return undefined

          const files = (yield* fs.readDirectory(dir).pipe(Effect.mapError(fail(dir)))).filter((n) =>
            SNAPSHOT_FILE.test(n)
          )

          return files.length < 2 ? undefined : files.toSorted().at(-1)?.slice(0, 10)
        })

        return Snapshots.of({ record, lastChanged })
      })
    )
}
