import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import * as Toml from "smol-toml"
import { Card, Issuer, Program } from "../model/schema.ts"

// Reads and writes the TOML dataset under data/:
//   programs/<id>.toml
//   issuers/<issuer>/issuer.toml
//   issuers/<issuer>/cards/<card>.toml

export interface Dataset {
  readonly programs: ReadonlyMap<string, Program>
  readonly issuers: ReadonlyMap<string, Issuer>
  // Keyed by "<issuer>/<card>"
  readonly cards: ReadonlyMap<string, Card>
}

export const cardKey = (issuer: string, card: string) => `${issuer}/${card}`
export const splitCardKey = (key: string) => {
  const [issuer, card] = key.split("/") as [string, string]
  return { issuer, card }
}

export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  file: Schema.String,
  message: Schema.String
}) {}

export class Store extends Context.Service<Store, {
  readonly load: Effect.Effect<Dataset, StoreError>
  writeCard(issuer: string, card: string, value: Card): Effect.Effect<boolean, StoreError>
  writeIssuer(issuer: string, value: Issuer): Effect.Effect<boolean, StoreError>
  writeProgram(id: string, value: Program): Effect.Effect<boolean, StoreError>
}>()("creditcards/store/Store") {
  static readonly layer = (dataDir: string) =>
    Layer.effect(
      Store,
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const fail = (file: string) => (cause: unknown) =>
          new StoreError({ file, message: cause instanceof Error ? cause.message : String(cause) })

        const readToml = <S extends Schema.Codec<any, any>>(schema: S, file: string) =>
          fs.readFileString(file).pipe(
            Effect.flatMap((text) => Effect.try({ try: () => Toml.parse(text), catch: fail(file) })),
            Effect.flatMap((data) => Schema.decodeUnknownEffect(schema)(data)),
            Effect.mapError(fail(file))
          ) as Effect.Effect<S["Type"], StoreError>

        const listDir = (dir: string) =>
          fs.exists(dir).pipe(
            Effect.flatMap((exists) => (exists ? fs.readDirectory(dir) : Effect.succeed([]))),
            Effect.map((names) => names.sort()),
            Effect.mapError(fail(dir))
          )

        const tomlFiles = (dir: string) =>
          listDir(dir).pipe(Effect.map((names) => names.filter((n) => n.endsWith(".toml")).map((n) => n.slice(0, -5))))

        const load = Effect.gen(function*() {
          const programs = new Map<string, Program>()
          for (const id of yield* tomlFiles(path.join(dataDir, "programs"))) {
            programs.set(id, yield* readToml(Program, path.join(dataDir, "programs", `${id}.toml`)))
          }
          const issuers = new Map<string, Issuer>()
          const cards = new Map<string, Card>()
          for (const issuer of yield* listDir(path.join(dataDir, "issuers"))) {
            const dir = path.join(dataDir, "issuers", issuer)
            issuers.set(issuer, yield* readToml(Issuer, path.join(dir, "issuer.toml")))
            for (const card of yield* tomlFiles(path.join(dir, "cards"))) {
              cards.set(cardKey(issuer, card), yield* readToml(Card, path.join(dir, "cards", `${card}.toml`)))
            }
          }
          return { programs, issuers, cards } satisfies Dataset
        }).pipe(Effect.withSpan("Store.load"))

        // Writes only when the encoded content differs; returns whether it wrote.
        const writeToml = <S extends Schema.Codec<any, any>>(schema: S, file: string, value: S["Type"]) =>
          Effect.gen(function*() {
            const encoded = yield* Schema.encodeUnknownEffect(schema)(value).pipe(Effect.mapError(fail(file)))
            const text = `${Toml.stringify(encoded)}\n`
            const current = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => undefined))
            if (current === text) return false
            yield* fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(Effect.mapError(fail(file)))
            yield* fs.writeFileString(file, text).pipe(Effect.mapError(fail(file)))
            return true
          })

        return Store.of({
          load,
          writeCard: (issuer, card, value) =>
            writeToml(Card, path.join(dataDir, "issuers", issuer, "cards", `${card}.toml`), value),
          writeIssuer: (issuer, value) => writeToml(Issuer, path.join(dataDir, "issuers", issuer, "issuer.toml"), value),
          writeProgram: (id, value) => writeToml(Program, path.join(dataDir, "programs", `${id}.toml`), value)
        })
      })
    )
}
