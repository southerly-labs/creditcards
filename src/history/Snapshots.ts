import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  Schema,
  String as EffectString,
  Array as EffectArray,
  Record as EffectRecord,
  pipe,
  Order,
  Option
} from "effect"
import { encodeJson } from "../util/json.ts"

export interface CdrSnapshot {
  readonly brand: string
  readonly version: number | null
  readonly product: unknown
}

export class SnapshotError extends Schema.TaggedError<SnapshotError, { readonly brand: unique symbol }>()(
  "SnapshotError",
  {
    file: Schema.String,
    message: Schema.String
  }
) {}

const byKey = Order.mapInput(Order.String, ([key]: readonly [string, unknown]) => key)

const sortKeys = (value: unknown): unknown => {
  if (EffectArray.isArray(value)) return EffectArray.map(value, (item: unknown) => sortKeys(item))

  if (value === null || typeof value !== "object") return value
  const sorted: Record<string, unknown> = {}

  for (const [key, item] of EffectArray.sort(EffectRecord.toEntries(value), byKey)) sorted[key] = sortKeys(item)

  return sorted
}

export const encodeSnapshot = (snapshot: CdrSnapshot): string =>
  `${encodeJson(sortKeys({ brand: snapshot.brand, version: snapshot.version, product: snapshot.product }), 2)}\n`

const Saved = Schema.fromJsonString(Schema.Struct({ brand: Schema.String, product: Schema.Unknown }))

const byEncoding = Order.mapInput(Order.String, (value: unknown) => encodeJson(value))

const canonical = (value: unknown, skip: ReadonlySet<string> = new Set()): unknown => {
  if (EffectArray.isArray(value))
    return EffectArray.sort(
      EffectArray.map(value, (item: unknown) => canonical(item)),
      byEncoding
    )

  if (value === null || typeof value !== "object") return value
  const result: Record<string, unknown> = {}

  for (const [key, item] of EffectArray.sort(EffectRecord.toEntries(value), byKey))
    if (!skip.has(key)) result[key] = canonical(item)

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
    previous(
      issuer: string,
      productId: string,
      current: Pick<CdrSnapshot, "brand" | "product">
    ): Effect.Effect<{ readonly date: string; readonly product: unknown } | undefined, SnapshotError>
  }
>()("creditcards/history/Snapshots") {
  static readonly layer = (historyDir: string) =>
    Layer.effect(
      Snapshots,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path

        const fail = (file: string) => (cause: unknown) =>
          SnapshotError.make({ file, message: cause instanceof Error ? cause.message : String(cause) })

        const record = Effect.fn("Snapshots.record")(function* (
          issuer: string,
          productId: string,
          date: string,
          snapshot: CdrSnapshot
        ) {
          const dir = path.join(historyDir, "cdr", productDir(issuer, productId))
          const text = encodeSnapshot(snapshot)

          const existing = (yield* fs.exists(dir).pipe(Effect.mapError(fail(dir))))
            ? EffectArray.filter(yield* fs.readDirectory(dir).pipe(Effect.mapError(fail(dir))), (n) =>
                SNAPSHOT_FILE.test(n)
              )
            : []

          const latest = Option.getOrUndefined(EffectArray.last(EffectArray.sort(existing, Order.String)))

          if (latest !== undefined) {
            const latestFile = path.join(dir, latest)
            const current = yield* fs.readFileString(latestFile).pipe(Effect.mapError(fail(latestFile)))

            const saved = yield* Schema.decodeEffect(Saved)(current).pipe(Effect.mapError(fail(latestFile)))

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

          const files = EffectArray.filter(yield* fs.readDirectory(dir).pipe(Effect.mapError(fail(dir))), (n) =>
            SNAPSHOT_FILE.test(n)
          )

          return files.length < 2
            ? undefined
            : pipe(
                EffectArray.sort(files, Order.String),
                EffectArray.last,
                Option.map(EffectString.slice(0, 10)),
                Option.getOrUndefined
              )
        })

        const previous = Effect.fn("Snapshots.previous")(function* (
          issuer: string,
          productId: string,
          current: Pick<CdrSnapshot, "brand" | "product">
        ) {
          const dir = path.join(historyDir, "cdr", productDir(issuer, productId))

          if (!(yield* fs.exists(dir).pipe(Effect.mapError(fail(dir))))) return undefined

          const files = EffectArray.take(
            EffectArray.sort(
              EffectArray.filter(yield* fs.readDirectory(dir).pipe(Effect.mapError(fail(dir))), (n) =>
                SNAPSHOT_FILE.test(n)
              ),
              Order.flip(Order.String)
            ),
            2
          )

          for (const name of files) {
            const file = path.join(dir, name)
            const text = yield* fs.readFileString(file).pipe(Effect.mapError(fail(file)))
            const saved = yield* Schema.decodeEffect(Saved)(text).pipe(Effect.mapError(fail(file)))

            if (!sameProduct({ ...saved, version: null }, current))
              return { date: pipe(name, EffectString.slice(0, 10)), product: saved.product }
          }

          return undefined
        })

        return Snapshots.of({ record, lastChanged, previous })
      })
    )
}
