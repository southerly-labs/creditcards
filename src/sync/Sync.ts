import { encodeJson } from "../util/json.ts"
import { required } from "../util/required.ts"
import {
  DateTime,
  Effect,
  Option,
  Result,
  Schema,
  Array as EffectArray,
  Record as EffectRecord,
  String as EffectString
} from "effect"
import { CdrClient, type CdrError, REQUEST_VARIANTS, type VersionedProduct } from "../cdr/CdrClient.ts"
import { makeProgramIndex, normalise, type NormaliseResult } from "../cdr/normalise.ts"
import { type CdrSnapshot, productDir, Snapshots } from "../history/Snapshots.ts"
import { ProductDetail, type ProductSummary } from "../cdr/schema.ts"
import { type BonusTranche, Card, type EarnRate, type Issuer, type Program } from "../model/schema.ts"
import { applyOffers, signupState } from "../offers/build.ts"
import { holdCandidates, holdId, resolveHolds, revertChange, withCdrEvidence } from "./holds.ts"
import type { Hold } from "../model/holds.ts"
import { HoldState, isPending } from "../machine/hold.ts"
import { isResolvableFromCdr } from "../rewards/bonus.ts"
import { bonusRead, earnRead, earnStateOf } from "../rewards/state.ts"
import { stepReview } from "../machine/review.ts"
import { applyBonusPlan, BonusPlan, planBonus, planRewards, RewardsPlan } from "../rewards/plan.ts"
import { cardKey, splitCardKey, Store } from "../store/Store.ts"
import { cardSlug, issuerSeed } from "./issuers.ts"
import {
  diffCard,
  type FieldChange,
  MAX_DISCONTINUED_SHARE,
  mergeCard,
  MIN_SEEN_SHARE,
  observeMergedGaps
} from "./merge.ts"
import { isDelisted, lifecycleLocked, lifecycleOf, notSeen, seen, withLifecycle } from "../model/lifecycle.ts"
import { ListingState } from "../machine/cardLifecycle.ts"
import { fetched as fetchedEvent, FetchState, reportedFailure, settleFetch, stepFetch } from "../machine/brandFetch.ts"

const CATEGORY = "CRED_AND_CHRG_CARDS"

const bonusFeatures = (p: ProductDetail) =>
  EffectArray.filter(p.features ?? [], (f) => f.featureType === "BONUS_REWARDS")

export interface SyncReport {
  readonly date: string
  readonly cardsSeen: number
  readonly added: ReadonlyArray<string>
  readonly updated: ReadonlyArray<{ readonly card: string; readonly changes: ReadonlyArray<FieldChange> }>
  readonly discontinued: ReadonlyArray<string>
  readonly missing: ReadonlyArray<string>
  readonly held: ReadonlyArray<{ readonly card: string; readonly reasons: ReadonlyArray<string> }>
  readonly holds: ReadonlyArray<Hold>
  readonly released: ReadonlyArray<{ readonly id: string; readonly card: string; readonly change: string }>
  readonly newIssuers: ReadonlyArray<string>
  readonly newPrograms: ReadonlyArray<string>
  readonly brandErrors: ReadonlyArray<{ readonly brand: string; readonly error: string }>
  readonly cardlessBrandErrors: number
  readonly snapshotsSaved: number

  readonly rewards: {
    readonly set: ReadonlyArray<{ readonly card: string; readonly earn: ReadonlyArray<EarnRate> }>
    readonly review: ReadonlyArray<{ readonly card: string; readonly reason: string }>
  }

  readonly bonus: {
    readonly set: ReadonlyArray<{ readonly card: string; readonly bonus: ReadonlyArray<BonusTranche> }>
    readonly review: ReadonlyArray<{ readonly card: string; readonly reason: string }>
    readonly undetailed: ReadonlyArray<string>
  }
}

export class SyncAborted extends Schema.TaggedError<SyncAborted, { readonly brand: unique symbol }>()("SyncAborted", {
  message: Schema.String
}) {}

interface BrandFetch {
  readonly brand: string
  readonly products: ReadonlyArray<VersionedProduct>
  readonly listed: ReadonlyArray<string>

  readonly listError: string | undefined
  readonly productErrors: ReadonlyArray<string>
}

const decodeCard = Schema.decodeUnknownEffect(Card)

type Proposal =
  | { readonly earnPlan: RewardsPlan; readonly bonusPlan: BonusPlan; readonly card: Card; readonly invalid?: never }
  | { readonly earnPlan: RewardsPlan; readonly bonusPlan: BonusPlan; readonly card?: never; readonly invalid: string }

const proposeCard = Effect.fn("proposeCard")(function* (
  existing: Card | undefined,
  product: ProductDetail,
  normalised: NormaliseResult,
  date: string
) {
  const merged = mergeCard(existing, normalised.card)

  yield* observeMergedGaps(merged, existing)

  if (existing === undefined) merged["first_seen"] = date
  const mergedRewards = merged["rewards"]
  const hasRewards = mergedRewards !== undefined && Schema.is(Card.fields.rewards)(mergedRewards)
  const loyalty = EffectArray.filter(product.features ?? [], (f) => f.featureType === "LOYALTY_PROGRAM")

  const earnPlan = hasRewards
    ? yield* planRewards(mergedRewards, loyalty, earnStateOf(existing))
    : RewardsPlan.Unchanged()

  if (hasRewards) {
    const rewards = mergedRewards
    merged["rewards"] = RewardsPlan.$is("Set")(earnPlan) ? { ...rewards, earn: earnPlan.earn } : rewards
  }

  const currentSignup = signupState(existing)

  const bonusPlan: BonusPlan =
    merged["rewards"] === undefined ? BonusPlan.Unchanged() : yield* planBonus(currentSignup, bonusFeatures(product))

  const nextSignup = hasRewards
    ? yield* stepReview(currentSignup.state, yield* bonusRead(bonusFeatures(product)))
    : currentSignup.state

  if (hasRewards) {
    merged["earn_state"] = yield* stepReview(earnStateOf(existing), yield* earnRead(loyalty))
    merged["signup_state"] = nextSignup
  } else {
    delete merged["earn_state"]
    delete merged["signup_state"]
  }

  const decoded = yield* decodeCard(merged).pipe(Effect.result)

  if (Result.isFailure(decoded)) {
    return {
      earnPlan,
      bonusPlan,
      invalid: EffectArray.join(EffectString.split(decoded.failure.message, "\n").slice(0, 3), " ")
    } satisfies Proposal
  }

  const card = withLifecycle(
    yield* applyOffers(decoded.success, normalised.offers, {
      state: nextSignup,
      parsed: applyBonusPlan(currentSignup, bonusPlan)
    }),
    yield* seen(existing)
  )

  return { earnPlan, bonusPlan, card } satisfies Proposal
})

const decodeProduct = Schema.decodeUnknownEffect(ProductDetail)

const previousCard = Effect.fn("previousCard")(function* (
  existing: Card,
  productId: string,
  current: Pick<CdrSnapshot, "brand" | "product">,
  issuerSlug: string,
  date: string,
  programs: ReturnType<typeof makeProgramIndex>
) {
  const snapshot = yield* (yield* Snapshots).previous(issuerSlug, productId, current)

  if (snapshot === undefined) return undefined
  const detail = yield* decodeProduct(snapshot.product).pipe(Effect.option)

  if (Option.isNone(detail)) return undefined
  const normalised = normalise(detail.value, { issuerSlug, brandName: current.brand, programs })
  const proposal = yield* proposeCard(existing, detail.value, normalised, date)

  return proposal.card === undefined ? undefined : { date: snapshot.date, card: proposal.card }
})

export const syncCdr = Effect.fn("syncCdr")(function* (options: { readonly dryRun: boolean }) {
  const cdr = yield* CdrClient
  const store = yield* Store
  const snapshots = yield* Snapshots
  const now = yield* DateTime.now
  const date = DateTime.formatIsoDateUtc(now)
  const observedAt = DateTime.formatIso(now)

  const dataset = yield* store.load
  const issuers = new Map(dataset.issuers)
  const programs = new Map(dataset.programs)
  const cards = new Map(dataset.cards)
  const observations = new Map(dataset.observations)
  const programIndex = makeProgramIndex(EffectRecord.fromEntries(programs))

  const brands = yield* cdr.brands
  const activeByBrand = new Map<string, number>()

  for (const card of cards.values()) {
    if (!isDelisted(card) && card.cdr !== undefined)
      activeByBrand.set(card.cdr.brand, (activeByBrand.get(card.cdr.brand) ?? 0) + 1)
  }

  const fetchBrand = Effect.fn("syncCdr.fetchBrand")(function* (brand: (typeof brands)[number]) {
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
        listed: [],
        listError: listed.failure.message,
        productErrors: []
      } satisfies BrandFetch
    }

    const productErrors: Array<string> = []

    const products = yield* Effect.forEach(
      listed.success,
      (summary) =>
        cdr
          .getProduct(brand.publicBaseUri, summary.productId)
          .pipe(
            Effect.catchTag("CdrError", (e) =>
              Effect.sync(() => (productErrors.push(`${summary.name}: ${e.message}`), undefined))
            )
          ),
      { concurrency: 4 }
    )

    return {
      brand: brand.brandName,
      products: EffectArray.filter(products, (p) => p !== undefined),
      listed: EffectArray.map(listed.success, (summary) => summary.productId),
      listError:
        productErrors.length > 0 && productErrors.length === listed.success.length ? productErrors[0] : undefined,
      productErrors
    } satisfies BrandFetch
  })

  const firstPass = yield* Effect.forEach(brands, fetchBrand, { concurrency: 16 })

  const firstStates = yield* Effect.forEach(firstPass, (result) =>
    stepFetch(FetchState.cases.FirstTry.make({}), fetchedEvent(result.listError))
  )

  const retried = yield* Effect.forEach(
    EffectArray.filter(brands, (_, i) => FetchState.guards.Retrying(required(firstStates[i]))),
    (brand) => fetchBrand(brand),
    { concurrency: 1 }
  )

  const fetched = EffectArray.map(
    firstPass,
    (result) => Option.getOrUndefined(EffectArray.findFirst(retried, (retry) => retry.brand === result.brand)) ?? result
  )

  const finalStates = yield* Effect.forEach(fetched, (result, i) =>
    settleFetch(required(firstStates[i]), result.listError)
  )

  const cardsSeen = EffectArray.reduce(fetched, 0, (n, b) => n + b.products.length)

  const activeCdrCards = EffectArray.filter([...cards.values()], (c) => !isDelisted(c) && c.cdr !== undefined).length

  if (activeCdrCards > 0 && cardsSeen < activeCdrCards * MIN_SEEN_SHARE) {
    return yield* SyncAborted.make({
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

    const issuer: Issuer =
      current !== undefined
        ? { ...current, cdr_brands: [...current.cdr_brands, brand] }
        : { name: seed.name, cdr_brands: [brand] }

    issuers.set(seed.slug, issuer)
    issuerByBrand.set(brand, seed.slug)
    newIssuers.push(seed.slug)

    return seed.slug
  }

  const keyByCdrId = new Map<string, string>()

  for (const [key, card] of cards)
    if (card.cdr !== undefined) keyByCdrId.set(`${card.cdr.brand}|${card.cdr.product_id}`, key)

  const added: Array<string> = []
  const updated: Array<{ card: string; changes: ReadonlyArray<FieldChange> }> = []
  const held: Array<{ card: string; reasons: ReadonlyArray<string> }> = []
  const priorHolds = dataset.holds ?? []
  const holds: Array<Hold> = []
  const released: Array<{ id: string; card: string; change: string }> = []
  const evaluated = new Set<string>()
  const discontinued: Array<string> = []
  const missing: Array<string> = []
  const newPrograms: Array<string> = []
  const writes = new Map<string, Card>()
  const rewardsSet: Array<{ card: string; earn: ReadonlyArray<EarnRate> }> = []
  const rewardsReview: Array<{ card: string; reason: string }> = []
  const bonusSet: Array<{ card: string; bonus: ReadonlyArray<BonusTranche> }> = []
  const bonusReview: Array<{ card: string; reason: string }> = []
  const bonusUndetailed: Array<string> = []
  const snapshotWrites: Array<{ issuer: string; productId: string; snapshot: CdrSnapshot }> = []

  for (const { brand, products } of fetched) {
    if (products.length === 0) continue
    const issuerSlug = resolveIssuer(brand)
    const issuerName = required(issuers.get(issuerSlug)).name

    for (const { detail: product, raw, version } of products) {
      snapshotWrites.push({
        issuer: issuerSlug,
        productId: product.productId,
        snapshot: { brand, version: Number.isFinite(version) ? version : null, product: raw }
      })

      const normalised = normalise(product, { issuerSlug, brandName: brand, programs: programIndex })
      const { card: incoming, fallbackProgram } = normalised

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

      const proposal = yield* proposeCard(existing, product, normalised, date)
      const earnPlan = proposal.earnPlan
      const bonusPlan = proposal.bonusPlan
      const earnSet = RewardsPlan.$is("Set")(earnPlan) ? earnPlan.earn : undefined

      if (RewardsPlan.$is("Review")(earnPlan)) rewardsReview.push({ card: key, reason: earnPlan.reason })

      if (BonusPlan.$is("Review")(bonusPlan)) {
        if (isResolvableFromCdr(bonusPlan.reason)) bonusReview.push({ card: key, reason: bonusPlan.reason })
        else bonusUndetailed.push(key)
      }

      if (proposal.card === undefined) {
        held.push({ card: key, reasons: [`invalid: ${proposal.invalid}`] })
        continue
      }

      const proposed = proposal.card
      const flagged = existing !== undefined ? yield* holdCandidates(existing, proposed) : []

      const previous =
        existing !== undefined && EffectArray.some(flagged, (candidate) => candidate.kind === "approve")
          ? yield* previousCard(existing, product.productId, { brand, product: raw }, issuerSlug, date, programIndex)
          : undefined

      const candidates = yield* Effect.forEach(flagged, (candidate) => withCdrEvidence(candidate, previous))
      let card = proposed

      if (existing !== undefined) evaluated.add(key)

      const entries = EffectArray.filter(priorHolds, (hold) => hold.card === key)

      if (existing !== undefined && (candidates.length > 0 || entries.length > 0)) {
        const resolution = yield* resolveHolds({
          card: key,
          candidates,
          entries,
          date,
          history: existing.cdr && `history/cdr/${productDir(issuerSlug, existing.cdr.product_id)}/`
        })

        holds.push(...resolution.holds)

        for (const { change, proposed: value } of resolution.apply)
          released.push({ id: yield* holdId(key, change, value), card: key, change })

        const reverted = EffectArray.reduce<(typeof resolution.revert)[number], Card | undefined>(
          resolution.revert,
          proposed,
          (next, candidate) => next && revertChange(next, existing, candidate.change)
        )

        if (reverted === undefined) {
          held.push({ card: key, reasons: EffectArray.map(resolution.revert, (candidate) => candidate.reason) })
          continue
        }

        card = reverted
      }

      const changes = yield* diffCard(existing, card)

      observations.set(key, observedAt)

      if (changes.length === 0) continue

      writes.set(key, card)

      if (earnSet !== undefined) rewardsSet.push({ card: key, earn: earnSet })

      if (BonusPlan.$is("Set")(bonusPlan)) bonusSet.push({ card: key, bonus: bonusPlan.bonus })

      if (existing !== undefined) updated.push({ card: key, changes })
      else added.push(key)
    }
  }

  const seenIds = new Set(EffectArray.flatMap(fetched, (b) => EffectArray.map(b.listed, (id) => `${b.brand}|${id}`)))
  const brandStatus = new Map(EffectArray.map(fetched, (b) => [b.brand, b]))
  const missingByBrand = new Map<string, Array<string>>()

  for (const [key, card] of cards) {
    if (isDelisted(card) || card.cdr === undefined || seenIds.has(`${card.cdr.brand}|${card.cdr.product_id}`)) continue

    if (lifecycleLocked(card)) continue
    const status = brandStatus.get(card.cdr.brand)

    if (status === undefined || status.listError !== undefined) continue
    missingByBrand.set(card.cdr.brand, [...(missingByBrand.get(card.cdr.brand) ?? []), key])
  }

  for (const [brand, keys] of missingByBrand) {
    const active = EffectArray.filter([...cards.values()], (c) => !isDelisted(c) && c.cdr?.brand === brand).length

    if (keys.length / active > MAX_DISCONTINUED_SHARE && keys.length > 1) {
      for (const key of keys)
        held.push({ card: key, reasons: [`${keys.length}/${active} ${brand} cards vanished at once`] })
      continue
    }

    for (const key of keys) {
      const missingCard = required(cards.get(key))
      const before = lifecycleOf(missingCard)
      const after = yield* notSeen(missingCard, date)

      if (ListingState.guards.Delisted(after.listing)) {
        writes.set(key, withLifecycle(missingCard, after))
        discontinued.push(key)
        continue
      }

      if (after.listing._tag !== before.listing._tag) writes.set(key, withLifecycle(missingCard, after))
      missing.push(key)
    }
  }

  holds.push(...EffectArray.filter(priorHolds, (hold) => !evaluated.has(hold.card) && cards.has(hold.card)))

  const failedBrands = EffectArray.filter(fetched, (_, i) => reportedFailure(required(finalStates[i])))

  let snapshotsSaved = 0

  if (!options.dryRun) {
    for (const { issuer, productId, snapshot } of snapshotWrites)
      if (yield* snapshots.record(issuer, productId, date, snapshot)) snapshotsSaved++

    for (const slug of new Set(newIssuers)) yield* store.writeIssuer(slug, required(issuers.get(slug)))

    for (const id of newPrograms) yield* store.writeProgram(id, required(programs.get(id)))

    for (const [key, card] of writes) {
      const { issuer, card: slug } = splitCardKey(key)
      yield* store.writeCard(issuer, slug, card)
    }

    yield* store.writeObservations(observations)
    yield* store.writeHolds(holds)
  }

  return {
    date,
    cardsSeen,
    added,
    updated,
    discontinued,
    missing,
    held,
    holds,
    released,
    newIssuers: [...new Set(newIssuers)],
    newPrograms,
    brandErrors: EffectArray.map(
      EffectArray.filter(failedBrands, (b) => activeByBrand.has(b.brand)),
      (b) => ({ brand: b.brand, error: required(b.listError) })
    ),
    cardlessBrandErrors: EffectArray.filter(failedBrands, (b) => !activeByBrand.has(b.brand)).length,
    snapshotsSaved,
    rewards: { set: rewardsSet, review: rewardsReview },
    bonus: { set: bonusSet, review: bonusReview, undetailed: bonusUndetailed }
  } satisfies SyncReport
})

const formatValue = Effect.fn("formatValue")(function* (v: unknown) {
  if (v === undefined) return "—"

  return typeof v === "string" ? v : yield* encodeJson(v)
})

const formatChange = (c: FieldChange) =>
  Effect.zipWith(formatValue(c.before), formatValue(c.after), (before, after) => `${c.path} ${before} → ${after}`)

export const summariseReport = Effect.fn("summariseReport")(function* (r: SyncReport) {
  const lines = [
    `CDR sync ${r.date}: ${r.cardsSeen} cards seen, ${r.added.length} added, ${r.updated.length} updated, ` +
      `${r.discontinued.length} discontinued, ${r.held.length + EffectArray.filter(r.holds, (hold) => isPending(hold.state)).length} held`,
    ""
  ]

  if (r.added.length > 0) lines.push("Added:", ...EffectArray.map(r.added, (c) => `- ${c}`), "")

  if (r.updated.length > 0) {
    lines.push("Updated:")

    for (const u of r.updated) {
      const shown = EffectArray.filter(
        u.changes,
        (c) => !["cdr", "description", "earn_state", "signup_state"].includes(c.path)
      )

      lines.push(`- ${u.card}: ${EffectArray.join(yield* Effect.forEach(shown, formatChange), "; ") || "metadata"}`)
    }

    lines.push("")
  }

  if (r.discontinued.length > 0) lines.push("Discontinued:", ...EffectArray.map(r.discontinued, (c) => `- ${c}`), "")

  if (r.missing.length > 0) {
    lines.push(
      "Not seen (discontinued if still missing on a later day):",
      ...EffectArray.map(r.missing, (c) => `- ${c}`),
      ""
    )
  }

  lines.push(...summariseHolds(r))

  if (r.newPrograms.length > 0)
    lines.push("New fallback programs (add aliases or rename):", ...EffectArray.map(r.newPrograms, (p) => `- ${p}`), "")

  if (r.rewards.set.length > 0 || r.rewards.review.length > 0) {
    lines.push(`Earn rates: ${r.rewards.set.length} set by parser, ${r.rewards.review.length} need review`, "")
  }

  if (r.bonus.set.length > 0 || r.bonus.review.length > 0 || r.bonus.undetailed.length > 0) {
    lines.push(
      `Signup bonuses: ${r.bonus.set.length} set by parser, ${r.bonus.review.length} need review, ` +
        `${r.bonus.undetailed.length} named in CDR without details`,
      ""
    )
  }

  if (r.snapshotsSaved > 0) lines.push(`History: saved ${r.snapshotsSaved} changed CDR product responses`, "")

  if (r.brandErrors.length > 0)
    lines.push(
      "Brand errors (after a retry):",
      ...EffectArray.map(r.brandErrors, (b) => `- ${b.brand}: ${b.error}`),
      ""
    )

  if (r.cardlessBrandErrors > 0)
    lines.push(`Unreachable brands with no cards in the data: ${r.cardlessBrandErrors}`, "")

  return EffectArray.join(lines, "\n")
})

const earnReviewSection = (r: SyncReport) => [
  `${r.rewards.review.length} cards have earn rates the parser could not read (sync ${r.date}).`,
  "",
  "To resolve them locally, run `bun run cli rewards todo` (optionally `--issuer <slug>`), set",
  "`rewards.earn` from the CDR text it prints, then `bun run cli rewards stamp <issuer/card>...`.",
  'See "Earn rates" in the README. When a card has no fixed earn rate, comment',
  "`/earn-none <issuer/card>...` here instead.",
  "",
  ...EffectArray.map(r.rewards.review, (i) => `- [ ] \`${i.card}\` — ${i.reason}`)
]

const bonusReviewSection = (r: SyncReport) => [
  `${r.bonus.review.length} cards have signup bonuses the parser could not split by year (sync ${r.date}).`,
  "",
  "Run `bun run cli rewards bonus-todo`, write a manual signup offer from the CDR text it prints, then",
  '`bun run cli rewards bonus-stamp <issuer/card>...`. See "Signup bonuses" in the README. When a',
  "card has no current points offer, comment `/bonus-none <issuer/card>...` here instead.",
  "",
  ...EffectArray.map(r.bonus.review, (i) => `- [ ] \`${i.card}\` — ${i.reason}`)
]

export const summariseRewardsReview = (r: SyncReport): string => {
  const sections = [
    ...(r.rewards.review.length > 0 ? [earnReviewSection(r)] : []),
    ...(r.bonus.review.length > 0 ? [bonusReviewSection(r)] : [])
  ]

  if (sections.length === 0) return `No earn rates or signup bonuses need review (sync ${r.date}).`

  return EffectArray.join(
    EffectArray.map(sections, (lines) => EffectArray.join(lines, "\n")),
    "\n\n"
  )
}

const holdLine = (hold: Hold) =>
  `- \`${hold.id}\` ${hold.card} ${hold.change}: ${hold.reason} (since ${hold.since}${hold.history === undefined ? "" : `, ${hold.history}`})`

export const summariseHolds = (r: SyncReport): ReadonlyArray<string> => {
  const review = EffectArray.filter(r.holds, (hold) => HoldState.guards.AwaitingApproval(hold.state))
  const confirm = EffectArray.filter(r.holds, (hold) => HoldState.guards.AwaitingConfirmation(hold.state))
  const lines: Array<string> = []

  if (review.length > 0) {
    lines.push(
      "Held for review (comment `/approve <id> [why]` or `/reject <id> <why>` on the sync-held issue):",
      ...EffectArray.map(review, (hold) => holdLine(hold)),
      ""
    )
  }

  if (confirm.length > 0) {
    lines.push(
      "Waiting to confirm (applied if still proposed on a later day):",
      ...EffectArray.map(confirm, (hold) => holdLine(hold)),
      ""
    )
  }

  if (r.held.length > 0) {
    lines.push(
      "Whole cards held:",
      ...EffectArray.map(r.held, (h) => `- ${h.card}: ${EffectArray.join(h.reasons, "; ")}`),
      ""
    )
  }

  if (r.released.length > 0) {
    lines.push(
      "Applied after review or confirmation:",
      ...EffectArray.map(r.released, (h) => `- \`${h.id}\` ${h.card} ${h.change}`),
      ""
    )
  }

  return lines
}
