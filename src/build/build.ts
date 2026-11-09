import { required } from "../util/required.ts"
import { dual } from "effect/Function"
import { Effect, Result, Schema, Record as EffectRecord, Array as EffectArray } from "effect"
import { type Api, decodeApi, type PublicCard } from "../api/contract.ts"
import { datasetFreshness } from "../api/freshness.ts"
import { flatFromLifecycle } from "../machine/cardLifecycle.ts"
import { earnStateOf, publicRewards, publicSignupReview, signupStateOf } from "../rewards/state.ts"

export type { Api } from "../api/contract.ts"

import { type Dataset, splitCardKey, Store } from "../store/Store.ts"
import { isEffectiveLock } from "../sync/merge.ts"
import { cardBrand } from "../sync/brands.ts"
import { cardProblems } from "./consistency.ts"
import { holdIdProblems, holdProblems } from "./holdChecks.ts"

export class ValidationError extends Schema.TaggedError<ValidationError, { readonly brand: unique symbol }>()(
  "ValidationError",
  {
    problems: Schema.Array(Schema.String)
  }
) {}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

const compiles = (pattern: string): boolean => Result.isSuccess(Result.try(() => new RegExp(pattern, "iu")))

export const checkReferences = (dataset: Dataset): ReadonlyArray<string> => {
  const problems: Array<string> = []
  const cdrIds = new Map<string, string>()
  const namedIds = new Map<string, string>()
  const brandIssuer = new Map<string, string>()

  for (const [slug, issuer] of dataset.issuers) {
    if (!SLUG.test(slug)) problems.push(`issuers/${slug}: folder name is not a slug`)

    for (const brand of issuer.cdr_brands) {
      const other = brandIssuer.get(brand)

      if (other !== undefined) problems.push(`issuers/${slug}: CDR brand ${brand} also belongs to ${other}`)
      else brandIssuer.set(brand, slug)
    }
  }

  for (const [id, program] of dataset.programs) {
    if (!SLUG.test(id)) problems.push(`programs/${id}: file name is not a slug`)

    for (const alias of program.aliases ?? []) {
      if (!compiles(alias)) problems.push(`programs/${id}: alias ${alias} is not a valid regular expression`)
    }
  }

  for (const [key, card] of dataset.cards) {
    const { issuer, card: slug } = splitCardKey(key)

    if (!dataset.issuers.has(issuer)) problems.push(`${key}: unknown issuer ${issuer}`)

    if (!SLUG.test(slug)) problems.push(`${key}: file name is not a slug`)

    if (card.cdr !== undefined && dataset.issuers.has(issuer) && brandIssuer.get(card.cdr.brand) !== issuer)
      problems.push(`${key}: CDR brand ${card.cdr.brand} is not in ${issuer}'s cdr_brands`)

    for (const problem of cardProblems(card)) problems.push(`${key}: ${problem}`)

    for (const path of card.locked ?? []) {
      if (!isEffectiveLock(path)) problems.push(`${key}: the sync never writes ${path}, so locking it has no effect`)
    }

    const offerPrograms = EffectArray.flatMap(card.offers ?? [], (offer) =>
      EffectArray.flatMap(offer.components, (component) =>
        component.kind === "signup_points" ? [component.program] : []
      )
    )

    for (const id of [card.rewards?.program, ...(card.rewards?.partners ?? []), ...offerPrograms]) {
      if (id !== undefined && !dataset.programs.has(id)) problems.push(`${key}: unknown program ${id}`)
    }

    if (card.cdr !== undefined) {
      const matched = `${cardBrand(card.cdr)}|${card.cdr.product_id}`
      const named = `name:${card.cdr.brand}|${card.cdr.product_id}`
      const other = cdrIds.get(matched) ?? (card.cdr.brand_id === undefined ? namedIds.get(named) : cdrIds.get(named))

      if (other !== undefined) problems.push(`${key}: same CDR product as ${other}`)
      cdrIds.set(matched, key)
      namedIds.set(named, key)
    }
  }

  const holdIds = new Set<string>()

  for (const hold of dataset.holds ?? []) {
    if (!dataset.cards.has(hold.card)) problems.push(`sync-holds: unknown card ${hold.card}`)

    if (holdIds.has(hold.id)) problems.push(`sync-holds: duplicate id ${hold.id}`)
    holdIds.add(hold.id)
    problems.push(...holdProblems(hold))
  }

  for (const key of dataset.observations?.keys() ?? []) {
    if (!dataset.cards.has(key)) problems.push(`cdr-observations: unknown card ${key}`)
  }

  return problems
}

export const validate = Effect.gen(function* () {
  const dataset = yield* (yield* Store).load
  const problems = [...checkReferences(dataset), ...(yield* holdIdProblems(dataset.holds ?? []))]

  if (problems.length > 0) return yield* ValidationError.make({ problems })

  return dataset
}).pipe(Effect.withSpan("validate"))

const toApiImpl = (dataset: Dataset, generatedAt?: string): Api => {
  const programs = EffectRecord.fromEntries(
    EffectArray.map([...dataset.programs], ([id, { aliases: _a, priority: _p, ...rest }]) => [id, rest])
  )

  const issuers: Record<string, { name: string; website?: string; cards: Record<string, PublicCard> }> = {}

  for (const [slug, issuer] of dataset.issuers) {
    issuers[slug] = {
      name: issuer.name,
      ...(issuer.website != null && issuer.website !== "" ? { website: issuer.website } : {}),
      cards: {}
    }
  }

  for (const [key, card] of dataset.cards) {
    const { locked: _l, lifecycle, earn_state: _earnState, signup_state: _signupState, rewards, ...stored } = card

    const signupReview = publicSignupReview(signupStateOf(card))

    const { status, closed, missing_since, discontinued } = flatFromLifecycle(lifecycle)
    const { issuer, card: slug } = splitCardKey(key)
    const observedAt = dataset.observations?.get(key)
    const changedOn = dataset.changes?.get(key)

    const provenance = {
      ...stored.provenance,
      ...(observedAt === undefined ? {} : { cdr_observed_at: observedAt }),
      ...(changedOn === undefined ? {} : { cdr_changed_on: changedOn })
    }

    required(issuers[issuer]).cards[slug] = {
      ...stored,
      ...(rewards === undefined ? {} : { rewards: publicRewards(rewards, earnStateOf(card)) }),
      ...(signupReview === undefined ? {} : { signup_review: signupReview }),
      status,
      ...(closed === undefined ? {} : { closed }),
      ...(missing_since === undefined ? {} : { missing_since }),
      ...(discontinued === undefined ? {} : { discontinued }),
      ...(EffectRecord.keys<string, unknown>(provenance).length === 0 ? {} : { provenance })
    }
  }

  return {
    schema_version: 1,
    ...(generatedAt === undefined ? {} : { generated_at: generatedAt }),
    freshness: datasetFreshness(dataset),
    programs,
    issuers
  }
}

export const toApi = dual<
  (generatedAt?: string) => (dataset: Dataset) => Api,
  (dataset: Dataset, generatedAt?: string) => Api
>((args) => typeof args[0] === "object", toApiImpl)

export const publicApi = Effect.fn("publicApi")(function* (dataset: Dataset, generatedAt: string) {
  const api = toApi(dataset, generatedAt)

  yield* decodeApi(api).pipe(
    Effect.mapError((error) =>
      ValidationError.make({ problems: [`api.json does not match its contract: ${error.message}`] })
    )
  )

  return api
})
