import { required } from "../util/required.ts"
import { Effect, Schema } from "effect"
import { type Api, type PublicCard } from "../api/contract.ts"
import { datasetFreshness } from "../api/freshness.ts"

export type { Api } from "../api/contract.ts"

import { type Dataset, splitCardKey, Store } from "../store/Store.ts"

export class ValidationError extends Schema.TaggedError<ValidationError>()("ValidationError", {
  problems: Schema.Array(Schema.String)
}) {}

export const checkReferences = (dataset: Dataset): ReadonlyArray<string> => {
  const problems: Array<string> = []
  const cdrIds = new Map<string, string>()

  for (const [key, card] of dataset.cards) {
    const { issuer } = splitCardKey(key)

    if (!dataset.issuers.has(issuer)) problems.push(`${key}: unknown issuer ${issuer}`)

    const offerPrograms = (card.offers ?? []).flatMap((offer) =>
      offer.components.flatMap((component) => (component.kind === "signup_points" ? [component.program] : []))
    )

    for (const id of [card.rewards?.program, ...(card.rewards?.partners ?? []), ...offerPrograms]) {
      if (id !== undefined && !dataset.programs.has(id)) problems.push(`${key}: unknown program ${id}`)
    }

    if (card.cdr) {
      const cdrId = `${card.cdr.brand}|${card.cdr.product_id}`
      const other = cdrIds.get(cdrId)

      if (other != null && other !== "") problems.push(`${key}: same CDR product as ${other}`)
      cdrIds.set(cdrId, key)
    }
  }

  const holdIds = new Set<string>()

  for (const hold of dataset.holds ?? []) {
    if (!dataset.cards.has(hold.card)) problems.push(`sync-holds: unknown card ${hold.card}`)

    if (holdIds.has(hold.id)) problems.push(`sync-holds: duplicate id ${hold.id}`)
    holdIds.add(hold.id)
  }

  for (const key of dataset.observations?.keys() ?? []) {
    if (!dataset.cards.has(key)) problems.push(`cdr-observations: unknown card ${key}`)
  }

  return problems
}

export const validate = Effect.gen(function* () {
  const dataset = yield* (yield* Store).load
  const problems = checkReferences(dataset)

  if (problems.length > 0) return yield* new ValidationError({ problems })

  return dataset
}).pipe(Effect.withSpan("validate"))

export const toApi = (dataset: Dataset, generatedAt?: string): Api => {
  const programs = Object.fromEntries(
    [...dataset.programs].map(([id, { aliases: _a, priority: _p, ...rest }]) => [id, rest])
  )

  const issuers: Record<string, { name: string; website?: string; cards: Record<string, PublicCard> }> = {}

  for (const [slug, issuer] of dataset.issuers) {
    issuers[slug] = {
      name: issuer.name,
      ...(issuer.website != null && issuer.website !== "" ? { website: issuer.website } : {}),
      cards: {}
    }
  }

  for (const [key, { locked: _l, ...stored }] of dataset.cards) {
    const { issuer, card: slug } = splitCardKey(key)
    const observedAt = dataset.observations?.get(key)
    const changedOn = dataset.changes?.get(key)

    const provenance = {
      ...stored.provenance,
      ...(observedAt === undefined ? {} : { cdr_observed_at: observedAt }),
      ...(changedOn === undefined ? {} : { cdr_changed_on: changedOn })
    }

    const card = { ...stored, ...(Object.keys(provenance).length === 0 ? {} : { provenance }) }

    required(issuers[issuer]).cards[slug] = card
  }

  return {
    schema_version: 1,
    ...(generatedAt === undefined ? {} : { generated_at: generatedAt }),
    freshness: datasetFreshness(dataset),
    programs,
    issuers
  }
}
