import { Effect, Schema } from "effect"
import { CdrClient } from "../cdr/CdrClient.ts"
import type { Card, EarnRate } from "../model/schema.ts"
import { splitCardKey, Store } from "../store/Store.ts"
import { loyaltyText, loyaltyTextHash } from "./parse.ts"
import { planRewards } from "./plan.ts"

// Local tooling for the human (or Claude Code session) that resolves earn
// rates the parser cannot read.

export interface ReviewItem {
  readonly card: string
  readonly name: string
  readonly program: string | undefined
  readonly reason: string
  readonly hash: string
  readonly text: string
  readonly earn: ReadonlyArray<EarnRate> | undefined
}

export class RewardsError extends Schema.TaggedError<RewardsError>()("RewardsError", {
  message: Schema.String
}) {}

const loyaltyFeatures = Effect.fnUntraced(function* (card: Card, baseUris: ReadonlyMap<string, string>) {
  const cdr = yield* CdrClient
  if (!card.cdr) return yield* new RewardsError({ message: `${card.name} has no CDR source` })
  const baseUri = baseUris.get(card.cdr.brand)
  if (!baseUri) return yield* new RewardsError({ message: `${card.cdr.brand} is not in the CDR Register` })
  const { detail } = yield* cdr.getProduct(baseUri, card.cdr.product_id)
  return (detail.features ?? []).filter((f) => f.featureType === "LOYALTY_PROGRAM")
})

const registerBaseUris = Effect.gen(function* () {
  const brands = yield* (yield* CdrClient).brands
  return new Map(brands.map((b) => [b.brandName, b.publicBaseUri]))
})

// Active rewards cards whose earn rates need a person, with their CDR text.
export const reviewQueue = Effect.fn("reviewQueue")(function* (issuer: string | undefined) {
  const dataset = yield* (yield* Store).load
  const baseUris = yield* registerBaseUris
  const candidates = [...dataset.cards].filter(
    ([key, card]) =>
      card.status === "active" && card.rewards && card.cdr && (!issuer || splitCardKey(key).issuer === issuer)
  )
  const items = yield* Effect.forEach(
    candidates,
    ([key, card]) =>
      loyaltyFeatures(card, baseUris).pipe(
        Effect.map((features): ReviewItem | undefined => {
          const plan = planRewards(card.rewards, features)
          if (plan._tag !== "Review") return undefined
          return {
            card: key,
            name: card.name,
            program: card.rewards?.program,
            reason: plan.reason,
            hash: plan.hash,
            text: loyaltyText(features),
            earn: card.rewards?.earn
          }
        }),
        Effect.catch((e) => Effect.logWarning(`${key}: ${e.message}`).pipe(Effect.as(undefined)))
      ),
    { concurrency: 8 }
  )
  return items.filter((i) => i !== undefined)
})

export const formatQueue = (items: ReadonlyArray<ReviewItem>): string =>
  [
    `# Earn rates to review (${items.length})`,
    "",
    "For each card, set `rewards.earn` in its TOML file from the text below (see the",
    "EarnRate comment in src/model/schema.ts for how tiers and categories work), then run",
    "`bun run cli rewards stamp <issuer/card>...` to mark it manually reviewed.",
    "Use `--none` when the text has no fixed earn rate.",
    "",
    ...items.flatMap((i) => [
      `## ${i.card} — ${i.name}`,
      "",
      `- File: data/issuers/${splitCardKey(i.card).issuer}/cards/${splitCardKey(i.card).card}.toml`,
      `- Program: ${i.program ?? "—"}`,
      `- Reason: ${i.reason}`,
      `- Current earn: ${i.earn ? JSON.stringify(i.earn) : "—"}`,
      "",
      "```text",
      i.text || "(no loyalty text)",
      "```",
      ""
    ])
  ].join("\n")

// Marks cards' current earn rates as manually reviewed against the current
// CDR loyalty text, so the sync stops flagging them until the text changes.
export const stamp = Effect.fn("stamp")(function* (keys: ReadonlyArray<string>, none: boolean) {
  const store = yield* Store
  const dataset = yield* store.load
  const baseUris = yield* registerBaseUris
  for (const key of keys) {
    const card = dataset.cards.get(key)
    if (!card) return yield* new RewardsError({ message: `Unknown card ${key}` })
    if (!card.rewards) return yield* new RewardsError({ message: `${key} has no rewards program` })
    const earn = none ? [] : card.rewards.earn
    if (!earn) return yield* new RewardsError({ message: `${key} has no rewards.earn; set it first or pass --none` })
    const hash = loyaltyTextHash(yield* loyaltyFeatures(card, baseUris))
    const { issuer, card: slug } = splitCardKey(key)
    yield* store.writeCard(issuer, slug, {
      ...card,
      rewards: { ...card.rewards, earn, earn_source: "manual", earn_text_hash: hash }
    })
    yield* Effect.logInfo(`Stamped ${key} (${hash})`)
  }
})
