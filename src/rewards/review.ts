import { encodeJson } from "../util/json.ts"
import { DateTime, Effect, Schema } from "effect"
import { CdrClient } from "../cdr/CdrClient.ts"
import type { BonusTranche, Card, EarnRate } from "../model/schema.ts"
import { withOffers } from "../offers/build.ts"
import { splitCardKey, Store } from "../store/Store.ts"
import { loyaltyText, loyaltyTextHash, type LoyaltyFeature } from "./parse.ts"
import { bonusText, bonusTextHash } from "./bonus.ts"
import { BonusPlan, planBonus, planRewards, RewardsPlan } from "./plan.ts"

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

const warnReviewFailure = (key: string, error: { readonly message: string }) =>
  Effect.logWarning(`${key}: ${error.message}`).pipe(Effect.map(() => undefined))

const productFeatures = Effect.fn("productFeatures")(function* (
  card: Card,
  baseUris: ReadonlyMap<string, string>,
  featureType: "LOYALTY_PROGRAM" | "BONUS_REWARDS"
) {
  const cdr = yield* CdrClient

  if (!card.cdr) return yield* new RewardsError({ message: `${card.name} has no CDR source` })
  const baseUri = baseUris.get(card.cdr.brand)

  if (baseUri === undefined || baseUri === "")
    return yield* new RewardsError({ message: `${card.cdr.brand} is not in the CDR Register` })
  const { detail } = yield* cdr.getProduct(baseUri, card.cdr.product_id)

  return (detail.features ?? []).filter((f) => f.featureType === featureType)
})

const loyaltyFeatures = (card: Card, baseUris: ReadonlyMap<string, string>) =>
  productFeatures(card, baseUris, "LOYALTY_PROGRAM")

const bonusFeatures = (card: Card, baseUris: ReadonlyMap<string, string>) =>
  productFeatures(card, baseUris, "BONUS_REWARDS")

const registerBaseUris = Effect.gen(function* () {
  const brands = yield* (yield* CdrClient).brands

  return new Map(brands.map((b) => [b.brandName, b.publicBaseUri]))
})

const toReviewItem = (key: string, card: Card, features: ReadonlyArray<LoyaltyFeature>): ReviewItem | undefined => {
  const plan = planRewards(card.rewards, features)

  if (!RewardsPlan.$is("Review")(plan)) return undefined

  return {
    card: key,
    name: card.name,
    program: card.rewards?.program,
    reason: plan.reason,
    hash: plan.hash,
    text: loyaltyText(features),
    earn: card.rewards?.earn
  }
}

const reviewCandidates = (cards: ReadonlyMap<string, Card>, issuer: string | undefined) =>
  [...cards].filter(
    ([key, card]) =>
      card.status === "active" &&
      card.rewards !== undefined &&
      card.cdr !== undefined &&
      (issuer === undefined || issuer === "" || splitCardKey(key).issuer === issuer)
  )

export const reviewQueue = Effect.fn("reviewQueue")(function* (issuer: string | undefined) {
  const dataset = yield* (yield* Store).load
  const baseUris = yield* registerBaseUris
  const candidates = reviewCandidates(dataset.cards, issuer)

  const items = yield* Effect.forEach(
    candidates,
    ([key, card]) =>
      loyaltyFeatures(card, baseUris).pipe(
        Effect.map((features) => toReviewItem(key, card, features)),
        Effect.catch((e) => warnReviewFailure(key, e))
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
    "docs/data-model.md for how tiers and categories work), then run",
    "`bun run cli rewards stamp <issuer/card>...` to mark it manually reviewed.",
    "Use `--none` when the text has no fixed earn rate.",
    "",
    ...items.flatMap((i) => [
      `## ${i.card} — ${i.name}`,
      "",
      `- File: data/issuers/${splitCardKey(i.card).issuer}/cards/${splitCardKey(i.card).card}.toml`,
      `- Program: ${i.program ?? "—"}`,
      `- Reason: ${i.reason}`,
      `- Current earn: ${i.earn ? encodeJson(i.earn) : "—"}`,
      "",
      "```text",
      i.text || "(no loyalty text)",
      "```",
      ""
    ])
  ].join("\n")

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
      rewards: {
        ...card.rewards,
        earn,
        earn_source: "manual",
        earn_text_hash: hash,
        earn_review: {
          state: earn.length === 0 ? "none" : "present",
          reviewed_at: DateTime.formatIsoDateUtc(yield* DateTime.now)
        }
      }
    })
    yield* Effect.logInfo(`Stamped ${key} (${hash})`)
  }

  return undefined
})

export interface BonusReviewItem {
  readonly card: string
  readonly name: string
  readonly program: string | undefined
  readonly reason: string
  readonly text: string
  readonly bonus: ReadonlyArray<BonusTranche> | undefined
  readonly bonusPoints: number | undefined
}

const toBonusReviewItem = (
  key: string,
  card: Card,
  features: ReadonlyArray<LoyaltyFeature>
): BonusReviewItem | undefined => {
  const plan = planBonus(card.rewards, features)

  if (!BonusPlan.$is("Review")(plan)) return undefined

  return {
    card: key,
    name: card.name,
    program: card.rewards?.program,
    reason: plan.reason,
    text: bonusText(features),
    bonus: card.rewards?.bonus,
    bonusPoints: card.rewards?.bonus_points
  }
}

export const bonusReviewQueue = Effect.fn("bonusReviewQueue")(function* (issuer: string | undefined) {
  const dataset = yield* (yield* Store).load
  const baseUris = yield* registerBaseUris

  const items = yield* Effect.forEach(
    reviewCandidates(dataset.cards, issuer),
    ([key, card]) =>
      bonusFeatures(card, baseUris).pipe(
        Effect.map((features) => toBonusReviewItem(key, card, features)),
        Effect.catch((e) => warnReviewFailure(key, e))
      ),
    { concurrency: 8 }
  )

  return items.filter((i) => i !== undefined)
})

export const formatBonusQueue = (items: ReadonlyArray<BonusReviewItem>): string =>
  [
    `# Signup bonuses to review (${items.length})`,
    "",
    "For each card, set `rewards.bonus` in its TOML file from the text below, one",
    "`[[rewards.bonus]]` table per tranche with `points`, `year` (1 or 2) and any of",
    "`min_spend`, `spend_days`, `keep_months` and `note` (see docs/data-model.md), then run",
    "`bun run cli rewards bonus-stamp <issuer/card>...`. Use `--none` when there is no",
    "current points offer, for example when it has expired or is cashback only.",
    "",
    ...items.flatMap((i) => [
      `## ${i.card} — ${i.name}`,
      "",
      `- File: data/issuers/${splitCardKey(i.card).issuer}/cards/${splitCardKey(i.card).card}.toml`,
      `- Program: ${i.program ?? "—"}`,
      `- Reason: ${i.reason}`,
      `- CDR bonus_points: ${i.bonusPoints ?? "—"}`,
      `- Current bonus: ${i.bonus ? encodeJson(i.bonus) : "—"}`,
      "",
      "```text",
      i.text || "(no bonus text)",
      "```",
      ""
    ])
  ].join("\n")

export const stampBonus = Effect.fn("stampBonus")(function* (keys: ReadonlyArray<string>, none: boolean) {
  const store = yield* Store
  const dataset = yield* store.load
  const baseUris = yield* registerBaseUris

  for (const key of keys) {
    const card = dataset.cards.get(key)

    if (!card) return yield* new RewardsError({ message: `Unknown card ${key}` })

    if (!card.rewards) return yield* new RewardsError({ message: `${key} has no rewards program` })
    const bonus = none ? [] : card.rewards.bonus

    if (!bonus) return yield* new RewardsError({ message: `${key} has no rewards.bonus; set it first or pass --none` })
    const hash = bonusTextHash(yield* bonusFeatures(card, baseUris))
    const { issuer, card: slug } = splitCardKey(key)
    yield* store.writeCard(
      issuer,
      slug,
      withOffers({
        ...card,
        rewards: {
          ...card.rewards,
          bonus,
          bonus_source: "manual",
          bonus_text_hash: hash,
          bonus_review: {
            state: bonus.length === 0 ? "none" : "present",
            reviewed_at: DateTime.formatIsoDateUtc(yield* DateTime.now)
          }
        }
      })
    )
    yield* Effect.logInfo(`Stamped bonus for ${key} (${hash})`)
  }

  return undefined
})
