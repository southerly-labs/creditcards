import { encodeJson } from "../util/json.ts"
import { DateTime, Effect, Schema, Array as EffectArray, Option } from "effect"
import { CdrClient } from "../cdr/CdrClient.ts"
import type { Card, EarnRate } from "../model/schema.ts"
import { isDelisted } from "../model/lifecycle.ts"
import { signupState } from "../offers/build.ts"
import type { Offer } from "../offers/schema.ts"
import { rawBonusPoints } from "../cdr/normalise.ts"
import { splitCardKey, Store } from "../store/Store.ts"
import { loyaltyText, loyaltyTextHash, type LoyaltyFeature } from "./parse.ts"
import { bonusText, bonusTextHash, isResolvableFromCdr } from "./bonus.ts"
import { BonusPlan, planBonus, planRewards, RewardsPlan } from "./plan.ts"
import { earnStateOf, signupStateOf } from "./state.ts"
import { ReviewEvent, stepReview } from "../machine/review.ts"

export interface ReviewItem {
  readonly card: string
  readonly name: string
  readonly program: string | undefined
  readonly reason: string
  readonly hash: string
  readonly text: string
  readonly earn: ReadonlyArray<EarnRate> | undefined
}

export class RewardsError extends Schema.TaggedError<RewardsError, { readonly brand: unique symbol }>()(
  "RewardsError",
  {
    message: Schema.String
  }
) {}

const warnReviewFailure = (key: string, error: { readonly message: string }) =>
  Effect.logWarning(`${key}: ${error.message}`).pipe(Effect.asVoid)

const productFeatures = Effect.fn("productFeatures")(function* (
  card: Card,
  baseUris: ReadonlyMap<string, string>,
  featureType: "LOYALTY_PROGRAM" | "BONUS_REWARDS"
) {
  const cdr = yield* CdrClient

  if (card.cdr === undefined) return yield* RewardsError.make({ message: `${card.name} has no CDR source` })
  const baseUri = baseUris.get(card.cdr.brand)

  if (baseUri === undefined || baseUri === "")
    return yield* RewardsError.make({ message: `${card.cdr.brand} is not in the CDR Register` })
  const { detail } = yield* cdr.getProduct(baseUri, card.cdr.product_id)

  return EffectArray.filter(detail.features ?? [], (f) => f.featureType === featureType)
})

const loyaltyFeatures = (card: Card, baseUris: ReadonlyMap<string, string>) =>
  productFeatures(card, baseUris, "LOYALTY_PROGRAM")

const bonusFeatures = (card: Card, baseUris: ReadonlyMap<string, string>) =>
  productFeatures(card, baseUris, "BONUS_REWARDS")

const registerBaseUris = Effect.gen(function* () {
  const brands = yield* (yield* CdrClient).brands

  return new Map(EffectArray.map(brands, (b) => [b.brandName, b.publicBaseUri]))
})

const toReviewItem = Effect.fn("toReviewItem")(function* (
  key: string,
  card: Card,
  features: ReadonlyArray<LoyaltyFeature>
) {
  const plan = yield* planRewards(card.rewards, features, earnStateOf(card))

  if (!RewardsPlan.$is("Review")(plan)) return undefined

  return {
    card: key,
    name: card.name,
    program: card.rewards?.program,
    reason: plan.reason,
    hash: plan.hash,
    text: loyaltyText(features),
    earn: card.rewards?.earn
  } satisfies ReviewItem
})

const reviewCandidates = (cards: ReadonlyMap<string, Card>, issuer: string | undefined) =>
  EffectArray.filter(
    [...cards],
    ([key, card]) =>
      !isDelisted(card) &&
      card.rewards !== undefined &&
      card.cdr !== undefined &&
      (issuer === undefined || issuer === "" || splitCardKey(key).issuer === issuer)
  )

const reviewItemFor = Effect.fn("reviewItemFor")(function* (
  key: string,
  card: Card,
  baseUris: ReadonlyMap<string, string>
) {
  return yield* toReviewItem(key, card, yield* loyaltyFeatures(card, baseUris))
})

export const reviewQueue = Effect.fn("reviewQueue")(function* (issuer: string | undefined) {
  const dataset = yield* (yield* Store).load
  const baseUris = yield* registerBaseUris
  const candidates = reviewCandidates(dataset.cards, issuer)

  const items = yield* Effect.forEach(
    candidates,
    ([key, card]) => reviewItemFor(key, card, baseUris).pipe(Effect.catch((e) => warnReviewFailure(key, e))),
    { concurrency: 8 }
  )

  return EffectArray.filter(items, (i) => i !== undefined)
})

const jsonOrDash = (value: unknown) => (value === undefined ? Effect.succeed("—") : encodeJson(value))

export const formatQueue = Effect.fn("formatQueue")(function* (items: ReadonlyArray<ReviewItem>) {
  const sections = yield* Effect.forEach(items, (i) =>
    Effect.map(jsonOrDash(i.earn), (earnJson) => [
      `## ${i.card} — ${i.name}`,
      "",
      `- File: data/issuers/${splitCardKey(i.card).issuer}/cards/${splitCardKey(i.card).card}.toml`,
      `- Program: ${i.program ?? "—"}`,
      `- Reason: ${i.reason}`,
      `- Current earn: ${earnJson}`,
      "",
      "```text",
      i.text || "(no loyalty text)",
      "```",
      ""
    ])
  )

  return EffectArray.join(
    [
      `# Earn rates to review (${items.length})`,
      "",
      "For each card, set `rewards.earn` in its TOML file from the text below (see the",
      "docs/data-model.md for how tiers and categories work), then run",
      "`bun run cli rewards stamp <issuer/card>...` to mark it manually reviewed.",
      "Use `--none` when the text has no fixed earn rate.",
      "",
      ...EffectArray.flatten(sections)
    ],
    "\n"
  )
})

export const stamp = Effect.fn("stamp")(function* (keys: ReadonlyArray<string>, none: boolean) {
  const store = yield* Store
  const dataset = yield* store.load
  const baseUris = yield* registerBaseUris

  for (const key of keys) {
    const card = dataset.cards.get(key)

    if (card === undefined) return yield* RewardsError.make({ message: `Unknown card ${key}` })

    if (card.rewards === undefined) return yield* RewardsError.make({ message: `${key} has no rewards program` })
    const earn = none ? [] : card.rewards.earn

    if (earn === undefined)
      return yield* RewardsError.make({ message: `${key} has no rewards.earn; set it first or pass --none` })
    const hash = yield* loyaltyTextHash(yield* loyaltyFeatures(card, baseUris))
    const { issuer, card: slug } = splitCardKey(key)
    const on = DateTime.formatIsoDateUtc(yield* DateTime.now)

    const earnState = yield* stepReview(
      earnStateOf(card),
      ReviewEvent.cases.Stamp.make({ hash, outcome: earn.length === 0 ? "none" : "present", on })
    )

    const rewards = card.rewards

    yield* store.writeCard(issuer, slug, {
      ...card,
      earn_state: earnState,
      rewards: { ...rewards, earn }
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
  readonly signup: Offer | undefined
  readonly bonusPoints: number | undefined
}

const toBonusReviewItem = Effect.fn("toBonusReviewItem")(function* (
  key: string,
  card: Card,
  features: ReadonlyArray<LoyaltyFeature>
) {
  const plan = yield* planBonus(signupState(card), features)

  if (!BonusPlan.$is("Review")(plan) || !isResolvableFromCdr(plan.reason)) return undefined

  return {
    card: key,
    name: card.name,
    program: card.rewards?.program,
    reason: plan.reason,
    text: bonusText(features),
    signup: Option.getOrUndefined(EffectArray.findFirst(card.offers ?? [], (offer) => offer.id === "signup")),
    bonusPoints: rawBonusPoints(features)
  } satisfies BonusReviewItem
})

const bonusReviewItemFor = Effect.fn("bonusReviewItemFor")(function* (
  key: string,
  card: Card,
  baseUris: ReadonlyMap<string, string>
) {
  return yield* toBonusReviewItem(key, card, yield* bonusFeatures(card, baseUris))
})

export const bonusReviewQueue = Effect.fn("bonusReviewQueue")(function* (issuer: string | undefined) {
  const dataset = yield* (yield* Store).load
  const baseUris = yield* registerBaseUris

  const items = yield* Effect.forEach(
    reviewCandidates(dataset.cards, issuer),
    ([key, card]) => bonusReviewItemFor(key, card, baseUris).pipe(Effect.catch((e) => warnReviewFailure(key, e))),
    { concurrency: 8 }
  )

  return EffectArray.filter(items, (i) => i !== undefined)
})

export const formatBonusQueue = Effect.fn("formatBonusQueue")(function* (items: ReadonlyArray<BonusReviewItem>) {
  const sections = yield* Effect.forEach(items, (i) =>
    Effect.map(jsonOrDash(i.signup), (signupJson) => [
      `## ${i.card} — ${i.name}`,
      "",
      `- File: data/issuers/${splitCardKey(i.card).issuer}/cards/${splitCardKey(i.card).card}.toml`,
      `- Program: ${i.program ?? "—"}`,
      `- Reason: ${i.reason}`,
      `- CDR bonus total: ${i.bonusPoints ?? "—"}`,
      `- Current signup offer: ${signupJson}`,
      "",
      "```text",
      i.text || "(no bonus text)",
      "```",
      ""
    ])
  )

  return EffectArray.join(
    [
      `# Signup bonuses to review (${items.length})`,
      "",
      "For each card, write the signup offer in its TOML file from the text below: an",
      '`[[offers]]` table with `id = "signup"` and `source = "manual"`, and one `signup_points`',
      "component per tranche with `program`, `points`, `year` (1 or 2) and any of `min_spend`,",
      "`spend_days`, `keep_months` and `note` (see docs/offers.md). Then run",
      "`bun run cli rewards bonus-stamp <issuer/card>...`. Use `--none` when there is no",
      "current points offer, for example when it has expired or is cashback only.",
      "",
      ...EffectArray.flatten(sections)
    ],
    "\n"
  )
})

export const stampBonus = Effect.fn("stampBonus")(function* (keys: ReadonlyArray<string>, none: boolean) {
  const store = yield* Store
  const dataset = yield* store.load
  const baseUris = yield* registerBaseUris

  for (const key of keys) {
    const card = dataset.cards.get(key)

    if (card === undefined) return yield* RewardsError.make({ message: `Unknown card ${key}` })

    if (card.rewards === undefined) return yield* RewardsError.make({ message: `${key} has no rewards program` })
    const others = EffectArray.filter(card.offers ?? [], (offer) => offer.id !== "signup")
    const signup = Option.getOrUndefined(EffectArray.findFirst(card.offers ?? [], (offer) => offer.id === "signup"))

    if (!none && signup === undefined) {
      return yield* RewardsError.make({ message: `${key} has no signup offer; write one first or pass --none` })
    }

    const offers = none || signup === undefined ? others : [...others, { ...signup, source: "manual" as const }]
    const hash = yield* bonusTextHash(yield* bonusFeatures(card, baseUris))
    const { issuer, card: slug } = splitCardKey(key)
    const { offers: _offers, ...rest } = card
    const on = DateTime.formatIsoDateUtc(yield* DateTime.now)

    const reviewed = yield* stepReview(
      signupStateOf(card),
      ReviewEvent.cases.Stamp.make({ hash, outcome: none ? "none" : "present", on })
    )

    yield* store.writeCard(issuer, slug, {
      ...rest,
      signup_state: reviewed,
      ...(offers.length === 0 ? {} : { offers })
    })
    yield* Effect.logInfo(`Stamped bonus for ${key} (${hash})`)
  }

  return undefined
})
