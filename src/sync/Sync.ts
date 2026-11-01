import { encodeJson } from "../util/json.ts"
import { required } from "../util/required.ts"
import { DateTime, Effect, Result, Schema } from "effect"
import { CdrClient, type CdrError, REQUEST_VARIANTS } from "../cdr/CdrClient.ts"
import { makeProgramIndex, normalise } from "../cdr/normalise.ts"
import type { ProductDetail, ProductSummary } from "../cdr/schema.ts"
import { type BonusTranche, Card, type EarnRate, type Issuer, type Program } from "../model/schema.ts"
import { applyBonusPlan, BonusPlan, planBonus, planRewards, RewardsPlan } from "../rewards/plan.ts"
import { cardKey, splitCardKey, Store } from "../store/Store.ts"
import { cardSlug, issuerSeed } from "./issuers.ts"
import { diffCard, type FieldChange, holdReasons, MAX_DISCONTINUED_SHARE, mergeCard, MIN_SEEN_SHARE } from "./merge.ts"

const CATEGORY = "CRED_AND_CHRG_CARDS"

const bonusFeatures = (p: ProductDetail) => (p.features ?? []).filter((f) => f.featureType === "BONUS_REWARDS")

export interface SyncReport {
  readonly date: string
  readonly cardsSeen: number
  readonly added: ReadonlyArray<string>
  readonly updated: ReadonlyArray<{ readonly card: string; readonly changes: ReadonlyArray<FieldChange> }>
  readonly discontinued: ReadonlyArray<string>
  readonly held: ReadonlyArray<{ readonly card: string; readonly reasons: ReadonlyArray<string> }>
  readonly newIssuers: ReadonlyArray<string>
  readonly newPrograms: ReadonlyArray<string>
  readonly brandErrors: ReadonlyArray<{ readonly brand: string; readonly error: string }>

  readonly rewards: {
    readonly set: ReadonlyArray<{ readonly card: string; readonly earn: ReadonlyArray<EarnRate> }>
    readonly review: ReadonlyArray<{ readonly card: string; readonly reason: string }>
  }

  readonly bonus: {
    readonly set: ReadonlyArray<{ readonly card: string; readonly bonus: ReadonlyArray<BonusTranche> }>
    readonly review: ReadonlyArray<{ readonly card: string; readonly reason: string }>
  }
}

export class SyncAborted extends Schema.TaggedError<SyncAborted>()("SyncAborted", {
  message: Schema.String
}) {}

interface BrandFetch {
  readonly brand: string
  readonly products: ReadonlyArray<ProductDetail>

  readonly listError: string | undefined
  readonly productErrors: ReadonlyArray<string>
}

const decodeCard = Schema.decodeUnknownEffect(Card)

export const syncCdr = Effect.fn("syncCdr")(function* (options: { readonly dryRun: boolean }) {
  const cdr = yield* CdrClient
  const store = yield* Store
  const date = DateTime.formatIsoDateUtc(yield* DateTime.now)

  const dataset = yield* store.load
  const issuers = new Map(dataset.issuers)
  const programs = new Map(dataset.programs)
  const cards = new Map(dataset.cards)
  const programIndex = makeProgramIndex(Object.fromEntries(programs))

  const brands = yield* cdr.brands
  const activeByBrand = new Map<string, number>()

  for (const card of cards.values()) {
    if (card.status === "active" && card.cdr)
      activeByBrand.set(card.cdr.brand, (activeByBrand.get(card.cdr.brand) ?? 0) + 1)
  }

  const fetched = yield* Effect.forEach(
    brands,
    (brand) =>
      Effect.gen(function* () {
        const expectsCards = (activeByBrand.get(brand.brandName) ?? 0) > 0

        const list = Effect.fn("CdrClient.listWithFallback")(function* (
          variant: number
        ): Effect.fn.Return<ReadonlyArray<ProductSummary>, CdrError> {
          const products = yield* cdr.listProducts(brand.publicBaseUri, CATEGORY, variant)

          return products.length === 0 && expectsCards && variant + 1 < REQUEST_VARIANTS.length
            ? yield* list(variant + 1)
            : products
        })

        const listed = yield* list(0).pipe(Effect.result)

        if (Result.isFailure(listed)) {
          return {
            brand: brand.brandName,
            products: [],
            listError: listed.failure.message,
            productErrors: []
          } satisfies BrandFetch
        }

        const productErrors: Array<string> = []

        const products = yield* Effect.forEach(
          listed.success,
          (summary) =>
            cdr.getProduct(brand.publicBaseUri, summary.productId).pipe(
              Effect.map((p) => p.detail),
              Effect.catchTag("CdrError", (e) =>
                Effect.sync(() => (productErrors.push(`${summary.name}: ${e.message}`), undefined))
              )
            ),
          { concurrency: 4 }
        )

        return {
          brand: brand.brandName,
          products: products.filter((p) => p !== undefined),
          listError:
            productErrors.length > 0 && productErrors.length === listed.success.length ? productErrors[0] : undefined,
          productErrors
        } satisfies BrandFetch
      }),
    { concurrency: 16 }
  )

  const cardsSeen = fetched.reduce((n, b) => n + b.products.length, 0)
  const activeCdrCards = [...cards.values()].filter((c) => c.status === "active" && c.cdr !== undefined).length

  if (activeCdrCards > 0 && cardsSeen < activeCdrCards * MIN_SEEN_SHARE) {
    return yield* new SyncAborted({
      message: `Only ${cardsSeen} cards returned vs ${activeCdrCards} active; refusing to sync (likely CDR outage)`
    })
  }

  const issuerByBrand = new Map<string, string>()

  for (const [slug, issuer] of issuers) for (const b of issuer.cdr_brands) issuerByBrand.set(b, slug)
  const newIssuers: Array<string> = []

  const resolveIssuer = (brand: string) => {
    const existing = issuerByBrand.get(brand)

    if (existing != null && existing !== "") return existing
    const seed = issuerSeed(brand)
    const current = issuers.get(seed.slug)

    const issuer: Issuer = current
      ? { ...current, cdr_brands: [...current.cdr_brands, brand] }
      : { name: seed.name, cdr_brands: [brand] }

    issuers.set(seed.slug, issuer)
    issuerByBrand.set(brand, seed.slug)
    newIssuers.push(seed.slug)

    return seed.slug
  }

  const keyByCdrId = new Map<string, string>()

  for (const [key, card] of cards) if (card.cdr) keyByCdrId.set(`${card.cdr.brand}|${card.cdr.product_id}`, key)

  const added: Array<string> = []
  const updated: Array<{ card: string; changes: ReadonlyArray<FieldChange> }> = []
  const held: Array<{ card: string; reasons: ReadonlyArray<string> }> = []
  const discontinued: Array<string> = []
  const newPrograms: Array<string> = []
  const writes = new Map<string, Card>()
  const rewardsSet: Array<{ card: string; earn: ReadonlyArray<EarnRate> }> = []
  const rewardsReview: Array<{ card: string; reason: string }> = []
  const bonusSet: Array<{ card: string; bonus: ReadonlyArray<BonusTranche> }> = []
  const bonusReview: Array<{ card: string; reason: string }> = []

  for (const { brand, products } of fetched) {
    if (products.length === 0) continue
    const issuerSlug = resolveIssuer(brand)
    const issuerName = required(issuers.get(issuerSlug)).name

    for (const product of products) {
      const { card: incoming, fallbackProgram } = normalise(product, {
        issuerSlug,
        brandName: brand,
        programs: programIndex
      })

      if (fallbackProgram != null && fallbackProgram !== "" && !programs.has(fallbackProgram)) {
        const program: Program = { name: `${issuerName} Rewards`, type: "bank" }
        programs.set(fallbackProgram, program)
        newPrograms.push(fallbackProgram)
      }

      let key = keyByCdrId.get(`${brand}|${product.productId}`)
      const existing = key != null && key !== "" ? cards.get(key) : undefined

      if (key == null || key === "") {
        const base = cardSlug(incoming.name, issuerName)

        let slug =
          cards.has(cardKey(issuerSlug, base)) || writes.has(cardKey(issuerSlug, base))
            ? `${base}-${incoming.type}`
            : base

        for (let i = 2; cards.has(cardKey(issuerSlug, slug)) || writes.has(cardKey(issuerSlug, slug)); i++)
          slug = `${base}-${i}`
        key = cardKey(issuerSlug, slug)
        keyByCdrId.set(`${brand}|${product.productId}`, key)
      }

      const merged = mergeCard(existing, incoming)
      let earnSet: ReadonlyArray<EarnRate> | undefined
      const mergedRewards = merged["rewards"]

      if (mergedRewards !== undefined && Schema.is(Card.fields.rewards)(mergedRewards)) {
        const loyalty = (product.features ?? []).filter((f) => f.featureType === "LOYALTY_PROGRAM")
        const plan = planRewards(mergedRewards, loyalty)

        if (RewardsPlan.$is("Set")(plan)) {
          merged["rewards"] = {
            ...mergedRewards,
            earn: plan.earn,
            earn_source: "parser",
            earn_text_hash: plan.hash,
            earn_review: { state: "present" }
          }
          earnSet = plan.earn
        } else if (RewardsPlan.$is("Review")(plan)) {
          rewardsReview.push({ card: key, reason: plan.reason })

          merged["rewards"] =
            mergedRewards.earn_source === "manual"
              ? mergedRewards
              : { ...mergedRewards, earn_review: { state: "unknown" } }
        }
      }

      const withEarn = merged["rewards"]
      let bonusPlan: BonusPlan = BonusPlan.Unchanged()

      if (withEarn !== undefined && Schema.is(Card.fields.rewards)(withEarn)) {
        bonusPlan = planBonus(withEarn, bonusFeatures(product))
        merged["rewards"] = applyBonusPlan(withEarn, bonusPlan)
      }

      if (BonusPlan.$is("Review")(bonusPlan)) bonusReview.push({ card: key, reason: bonusPlan.reason })

      const decoded = yield* decodeCard(merged).pipe(Effect.result)

      if (Result.isFailure(decoded)) {
        held.push({ card: key, reasons: [`invalid: ${decoded.failure.message.split("\n").slice(0, 3).join(" ")}`] })
        continue
      }

      const changes = diffCard(existing, merged)

      const reasons = existing ? holdReasons(changes) : []

      if (reasons.length > 0) {
        held.push({ card: key, reasons })
        continue
      }

      writes.set(key, {
        ...decoded.success,
        provenance: { ...decoded.success.provenance, cdr_observed_at: DateTime.formatIso(yield* DateTime.now) }
      })

      if (changes.length === 0) continue

      if (earnSet) rewardsSet.push({ card: key, earn: earnSet })

      if (BonusPlan.$is("Set")(bonusPlan)) bonusSet.push({ card: key, bonus: bonusPlan.bonus })

      if (existing) updated.push({ card: key, changes })
      else added.push(key)
    }
  }

  const seenIds = new Set(fetched.flatMap((b) => b.products.map((p) => `${b.brand}|${p.productId}`)))
  const brandStatus = new Map(fetched.map((b) => [b.brand, b]))
  const missingByBrand = new Map<string, Array<string>>()

  for (const [key, card] of cards) {
    if (card.status !== "active" || !card.cdr || seenIds.has(`${card.cdr.brand}|${card.cdr.product_id}`)) continue

    if ((card.locked ?? []).includes("status")) continue
    const status = brandStatus.get(card.cdr.brand)

    if (!status || status.listError !== undefined) continue
    missingByBrand.set(card.cdr.brand, [...(missingByBrand.get(card.cdr.brand) ?? []), key])
  }

  for (const [brand, keys] of missingByBrand) {
    const active = [...cards.values()].filter((c) => c.status === "active" && c.cdr?.brand === brand).length

    if (keys.length / active > MAX_DISCONTINUED_SHARE && keys.length > 1) {
      for (const key of keys)
        held.push({ card: key, reasons: [`${keys.length}/${active} ${brand} cards vanished at once`] })
      continue
    }

    for (const key of keys) {
      const missingCard = required(cards.get(key))
      writes.set(key, { ...missingCard, status: "discontinued", discontinued: date })
      discontinued.push(key)
    }
  }

  if (!options.dryRun) {
    for (const slug of new Set(newIssuers)) yield* store.writeIssuer(slug, required(issuers.get(slug)))

    for (const id of newPrograms) yield* store.writeProgram(id, required(programs.get(id)))

    for (const [key, card] of writes) {
      const { issuer, card: slug } = splitCardKey(key)
      yield* store.writeCard(issuer, slug, card)
    }
  }

  return {
    date,
    cardsSeen,
    added,
    updated,
    discontinued,
    held,
    newIssuers: [...new Set(newIssuers)],
    newPrograms,
    brandErrors: fetched
      .filter((b) => b.listError !== undefined && !/HTTP 4\d\d/u.test(b.listError))
      .map((b) => ({ brand: b.brand, error: required(b.listError) })),
    rewards: { set: rewardsSet, review: rewardsReview },
    bonus: { set: bonusSet, review: bonusReview }
  } satisfies SyncReport
})

export const summariseReport = (r: SyncReport): string => {
  const fmt = (v: unknown) =>
    v === undefined ? "—" : typeof v === "object" ? encodeJson(v) : typeof v === "string" ? v : encodeJson(v)

  const lines = [
    `CDR sync ${r.date}: ${r.cardsSeen} cards seen, ${r.added.length} added, ${r.updated.length} updated, ` +
      `${r.discontinued.length} discontinued, ${r.held.length} held`,
    ""
  ]

  if (r.added.length > 0) lines.push("Added:", ...r.added.map((c) => `- ${c}`), "")

  if (r.updated.length > 0) {
    lines.push("Updated:")

    for (const u of r.updated) {
      const shown = u.changes.filter(
        (c) =>
          ![
            "cdr",
            "description",
            "rewards.earn_source",
            "rewards.earn_text_hash",
            "rewards.bonus_source",
            "rewards.bonus_text_hash"
          ].includes(c.path)
      )

      lines.push(
        `- ${u.card}: ${shown.map((c) => `${c.path} ${fmt(c.before)} → ${fmt(c.after)}`).join("; ") || "metadata"}`
      )
    }

    lines.push("")
  }

  if (r.discontinued.length > 0) lines.push("Discontinued:", ...r.discontinued.map((c) => `- ${c}`), "")

  if (r.held.length > 0)
    lines.push("Held for review:", ...r.held.map((h) => `- ${h.card}: ${h.reasons.join("; ")}`), "")

  if (r.newPrograms.length > 0)
    lines.push("New fallback programs (add aliases or rename):", ...r.newPrograms.map((p) => `- ${p}`), "")

  if (r.rewards.set.length > 0 || r.rewards.review.length > 0) {
    lines.push(`Earn rates: ${r.rewards.set.length} set by parser, ${r.rewards.review.length} need review`, "")
  }

  if (r.bonus.set.length > 0 || r.bonus.review.length > 0) {
    lines.push(`Signup bonuses: ${r.bonus.set.length} set by parser, ${r.bonus.review.length} need review`, "")
  }

  if (r.brandErrors.length > 0) lines.push("Brand errors:", ...r.brandErrors.map((b) => `- ${b.brand}: ${b.error}`), "")

  return lines.join("\n")
}

const earnReviewSection = (r: SyncReport) => [
  `${r.rewards.review.length} cards have earn rates the parser could not read (sync ${r.date}).`,
  "",
  "To resolve them locally, run `bun run cli rewards todo` (optionally `--issuer <slug>`), set",
  "`rewards.earn` from the CDR text it prints, then `bun run cli rewards stamp <issuer/card>...`.",
  'See "Earn rates" in the README.',
  "",
  ...r.rewards.review.map((i) => `- [ ] \`${i.card}\` — ${i.reason}`)
]

const bonusReviewSection = (r: SyncReport) => [
  `${r.bonus.review.length} cards have signup bonuses the parser could not split by year (sync ${r.date}).`,
  "",
  "Run `bun run cli rewards bonus-todo`, set `rewards.bonus` from the CDR text it prints, then",
  '`bun run cli rewards bonus-stamp <issuer/card>...`. See "Signup bonuses" in the README.',
  "",
  ...r.bonus.review.map((i) => `- [ ] \`${i.card}\` — ${i.reason}`)
]

export const summariseRewardsReview = (r: SyncReport): string => {
  const sections = [
    ...(r.rewards.review.length > 0 ? [earnReviewSection(r)] : []),
    ...(r.bonus.review.length > 0 ? [bonusReviewSection(r)] : [])
  ]

  if (sections.length === 0) return `No earn rates or signup bonuses need review (sync ${r.date}).`

  return sections.map((lines) => lines.join("\n")).join("\n\n")
}
