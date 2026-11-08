import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, Layer, Path, Schema, Array as EffectArray, Order } from "effect"
import { Digest } from "effect/crypto"
import { ProductDetail } from "../../src/cdr/schema.ts"
import { productDir } from "../../src/history/Snapshots.ts"
import type { SourceReview } from "../../src/machine/review.ts"
import type { Card } from "../../src/model/schema.ts"
import { bonusText, bonusTextHash } from "../../src/rewards/bonus.ts"
import { type LoyaltyFeature, loyaltyText, loyaltyTextHash } from "../../src/rewards/parse.ts"
import { splitCardKey, Store } from "../../src/store/Store.ts"
import { sha256Prefix } from "../../src/util/hash.ts"

const Saved = Schema.fromJsonString(Schema.Struct({ product: ProductDetail }))

interface Source {
  readonly featureType: "LOYALTY_PROGRAM" | "BONUS_REWARDS"
  readonly text: (features: ReadonlyArray<LoyaltyFeature>) => string
  readonly hash: (features: ReadonlyArray<LoyaltyFeature>) => Effect.Effect<string, never, Digest.Digest>
}

const EARN: Source = { featureType: "LOYALTY_PROGRAM", text: loyaltyText, hash: loyaltyTextHash }

const BONUS: Source = { featureType: "BONUS_REWARDS", text: bonusText, hash: bonusTextHash }

const savedProducts = Effect.fn("savedProducts")(function* (key: string, card: Card) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  if (card.cdr === undefined) return []
  const dir = path.join("history", "cdr", productDir(splitCardKey(key).issuer, card.cdr.product_id))

  if (!(yield* fs.exists(dir))) return []

  const names = EffectArray.sort(
    EffectArray.filter(yield* fs.readDirectory(dir), (name) => name.endsWith(".json")),
    Order.flip(Order.String)
  )

  return yield* Effect.forEach(names, (name) =>
    fs.readFileString(path.join(dir, name)).pipe(
      Effect.flatMap(Schema.decodeEffect(Saved)),
      Effect.map((saved) => saved.product)
    )
  )
})

const rehash = Effect.fn("rehash")(function* (
  state: SourceReview | undefined,
  products: ReadonlyArray<ProductDetail>,
  source: Source
) {
  if (state === undefined || !("hash" in state)) return { state, matched: true }

  for (const product of products) {
    const features = EffectArray.filter(product.features ?? [], (f) => f.featureType === source.featureType)

    const current = yield* source.hash(features)

    if (current === state.hash) return { state, matched: true }

    if ((yield* sha256Prefix(source.text(features), 16)) === state.hash)
      return { state: { ...state, hash: current }, matched: true }
  }

  return { state, matched: false }
})

const migrate = Effect.gen(function* () {
  const store = yield* Store
  const { cards } = yield* store.load
  let rewritten = 0
  const unmatched: Array<string> = []

  for (const [key, card] of cards) {
    const products = yield* savedProducts(key, card)
    const earn = yield* rehash(card.earn_state, products, EARN)
    const signup = yield* rehash(card.signup_state, products, BONUS)

    if (!earn.matched) unmatched.push(`${key} earn_state`)

    if (!signup.matched) unmatched.push(`${key} signup_state`)

    const next: Card = {
      ...card,
      ...(earn.state === undefined ? {} : { earn_state: earn.state }),
      ...(signup.state === undefined ? {} : { signup_state: signup.state })
    }

    const { issuer, card: slug } = splitCardKey(key)

    if (yield* store.writeCard(issuer, slug, next)) rewritten++
  }

  yield* Console.log(`Rewrote ${rewritten} cards`)

  for (const line of unmatched) yield* Console.log(`No saved CDR text matches ${line}; left as is`)
})

BunRuntime.runMain(
  migrate.pipe(
    Effect.provide(Layer.mergeAll(Store.layer("data"), Digest.layerWebCrypto)),
    Effect.provide(BunServices.layer)
  )
)
