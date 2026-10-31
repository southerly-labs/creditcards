import { DateTime, Effect, Schema } from "effect"
import { CdrClient } from "../cdr/CdrClient.ts"
import { makeProgramIndex, normalise } from "../cdr/normalise.ts"
import type { ProductDetail } from "../cdr/schema.ts"
import { Card, type Issuer, type Program } from "../model/schema.ts"
import { cardKey, splitCardKey, Store } from "../store/Store.ts"
import { cardSlug, issuerSeed } from "./issuers.ts"
import { diffCard, type FieldChange, holdReasons, MAX_DISCONTINUED_SHARE, mergeCard, MIN_SEEN_SHARE } from "./merge.ts"

const CATEGORY = "CRED_AND_CHRG_CARDS"

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
}

export class SyncAborted extends Schema.TaggedError<SyncAborted>()("SyncAborted", {
  message: Schema.String
}) {}

interface BrandFetch {
  readonly brand: string
  readonly products: ReadonlyArray<ProductDetail>
  // Set when the product list itself failed: treat the brand as unknown, not empty.
  readonly listError: string | undefined
  readonly productErrors: ReadonlyArray<string>
}

const decodeCard = Schema.decodeUnknownEffect(Card)

export const syncCdr = Effect.fn("syncCdr")(function*(options: { readonly dryRun: boolean }) {
  const cdr = yield* CdrClient
  const store = yield* Store
  const date = DateTime.formatIsoDateUtc(yield* DateTime.now)

  const dataset = yield* store.load
  const issuers = new Map(dataset.issuers)
  const programs = new Map(dataset.programs)
  const cards = new Map(dataset.cards)
  const programIndex = makeProgramIndex(Object.fromEntries(programs))

  // ---- Fetch ---------------------------------------------------------------
  const brands = yield* cdr.brands
  const fetched = yield* Effect.forEach(brands, (brand) =>
    Effect.gen(function*() {
      const listed = yield* cdr.listProducts(brand.publicBaseUri, CATEGORY).pipe(Effect.result)
      if (listed._tag === "Failure") {
        return { brand: brand.brandName, products: [], listError: listed.failure.message, productErrors: [] } satisfies BrandFetch
      }
      const productErrors: Array<string> = []
      const products = yield* Effect.forEach(listed.success, (summary) =>
        cdr.getProduct(brand.publicBaseUri, summary.productId).pipe(
          Effect.map((p) => p.detail),
          Effect.catchTag("CdrError", (e) => Effect.sync(() => (productErrors.push(`${summary.name}: ${e.message}`), undefined)))
        ), { concurrency: 4 })
      return {
        brand: brand.brandName,
        products: products.filter((p) => p !== undefined),
        listError: productErrors.length > 0 && productErrors.length === listed.success.length ? productErrors[0] : undefined,
        productErrors
      } satisfies BrandFetch
    }), { concurrency: 16 })

  // ---- Global guardrail ------------------------------------------------------
  const cardsSeen = fetched.reduce((n, b) => n + b.products.length, 0)
  const activeCdrCards = [...cards.values()].filter((c) => c.status === "active" && c.cdr).length
  if (activeCdrCards > 0 && cardsSeen < activeCdrCards * MIN_SEEN_SHARE) {
    return yield* new SyncAborted({
      message: `Only ${cardsSeen} cards returned vs ${activeCdrCards} active; refusing to sync (likely CDR outage)`
    })
  }

  // ---- Resolve issuers --------------------------------------------------------
  const issuerByBrand = new Map<string, string>()
  for (const [slug, issuer] of issuers) for (const b of issuer.cdr_brands) issuerByBrand.set(b, slug)
  const newIssuers: Array<string> = []
  const resolveIssuer = (brand: string) => {
    const existing = issuerByBrand.get(brand)
    if (existing) return existing
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

  // ---- Upsert seen cards ----------------------------------------------------------
  for (const { brand, products } of fetched) {
    if (products.length === 0) continue
    const issuerSlug = resolveIssuer(brand)
    const issuerName = issuers.get(issuerSlug)!.name
    for (const product of products) {
      const { card: incoming, fallbackProgram } = normalise(product, { issuerSlug, brandName: brand, programs: programIndex })
      if (fallbackProgram && !programs.has(fallbackProgram)) {
        const program: Program = { name: `${issuerName} Rewards`, type: "bank" }
        programs.set(fallbackProgram, program)
        newPrograms.push(fallbackProgram)
      }

      let key = keyByCdrId.get(`${brand}|${product.productId}`)
      const existing = key ? cards.get(key) : undefined
      if (!key) {
        const base = cardSlug(incoming.name, issuerName)
        let slug = cards.has(cardKey(issuerSlug, base)) || writes.has(cardKey(issuerSlug, base))
          ? `${base}-${incoming.type}` : base
        for (let i = 2; cards.has(cardKey(issuerSlug, slug)) || writes.has(cardKey(issuerSlug, slug)); i++) slug = `${base}-${i}`
        key = cardKey(issuerSlug, slug)
        keyByCdrId.set(`${brand}|${product.productId}`, key)
      }

      const merged = mergeCard(existing, incoming)
      const decoded = yield* decodeCard(merged).pipe(Effect.result)
      if (decoded._tag === "Failure") {
        held.push({ card: key, reasons: [`invalid: ${decoded.failure.message.split("\n").slice(0, 3).join(" ")}`] })
        continue
      }
      const changes = diffCard(existing, merged)
      if (changes.length === 0) continue
      const reasons = existing ? holdReasons(changes) : []
      if (reasons.length > 0) {
        held.push({ card: key, reasons })
        continue
      }
      writes.set(key, decoded.success)
      if (existing) updated.push({ card: key, changes })
      else added.push(key)
    }
  }

  // ---- Discontinue cards no longer returned -------------------------------------------
  const seenIds = new Set(fetched.flatMap((b) => b.products.map((p) => `${b.brand}|${p.productId}`)))
  const brandStatus = new Map(fetched.map((b) => [b.brand, b]))
  const missingByBrand = new Map<string, Array<string>>()
  for (const [key, card] of cards) {
    if (card.status !== "active" || !card.cdr || seenIds.has(`${card.cdr.brand}|${card.cdr.product_id}`)) continue
    if ((card.locked ?? []).includes("status")) continue
    const status = brandStatus.get(card.cdr.brand)
    // The brand left the register or its listing failed: unknown, not gone.
    if (!status || status.listError !== undefined) continue
    missingByBrand.set(card.cdr.brand, [...(missingByBrand.get(card.cdr.brand) ?? []), key])
  }
  for (const [brand, keys] of missingByBrand) {
    const active = [...cards.values()].filter((c) => c.status === "active" && c.cdr?.brand === brand).length
    if (keys.length / active > MAX_DISCONTINUED_SHARE && keys.length > 1) {
      for (const key of keys) held.push({ card: key, reasons: [`${keys.length}/${active} ${brand} cards vanished at once`] })
      continue
    }
    for (const key of keys) {
      writes.set(key, { ...cards.get(key)!, status: "discontinued", discontinued: date })
      discontinued.push(key)
    }
  }

  // ---- Write --------------------------------------------------------------------------
  if (!options.dryRun) {
    for (const slug of new Set(newIssuers)) yield* store.writeIssuer(slug, issuers.get(slug)!)
    for (const id of newPrograms) yield* store.writeProgram(id, programs.get(id)!)
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
    brandErrors: fetched.filter((b) => b.listError !== undefined && !/HTTP 4\d\d/.test(b.listError))
      .map((b) => ({ brand: b.brand, error: b.listError! }))
  } satisfies SyncReport
})


// Markdown summary used for the commit message body and the held-changes issue.
export const summariseReport = (r: SyncReport): string => {
  const fmt = (v: unknown) => (v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v))
  const lines = [
    `CDR sync ${r.date}: ${r.cardsSeen} cards seen, ${r.added.length} added, ${r.updated.length} updated, ` +
    `${r.discontinued.length} discontinued, ${r.held.length} held`,
    ""
  ]
  if (r.added.length) lines.push("Added:", ...r.added.map((c) => `- ${c}`), "")
  if (r.updated.length) {
    lines.push("Updated:")
    for (const u of r.updated) {
      const shown = u.changes.filter((c) => c.path !== "cdr" && c.path !== "description")
      lines.push(`- ${u.card}: ${shown.map((c) => `${c.path} ${fmt(c.before)} → ${fmt(c.after)}`).join("; ") || "metadata"}`)
    }
    lines.push("")
  }
  if (r.discontinued.length) lines.push("Discontinued:", ...r.discontinued.map((c) => `- ${c}`), "")
  if (r.held.length) lines.push("Held for review:", ...r.held.map((h) => `- ${h.card}: ${h.reasons.join("; ")}`), "")
  if (r.newPrograms.length) lines.push("New fallback programs (add aliases or rename):", ...r.newPrograms.map((p) => `- ${p}`), "")
  if (r.brandErrors.length) lines.push("Brand errors:", ...r.brandErrors.map((b) => `- ${b.brand}: ${b.error}`), "")
  return lines.join("\n")
}
