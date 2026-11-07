import { required } from "../util/required.ts"
import { dual } from "effect/Function"
import { Effect, Schema, Record as EffectRecord, Array as EffectArray } from "effect"
import { type Api, type PublicCard } from "../api/contract.ts"
import { datasetFreshness } from "../api/freshness.ts"
import { flatFromLifecycle } from "../machine/cardLifecycle.ts"

export type { Api } from "../api/contract.ts"

import { type Dataset, splitCardKey, Store } from "../store/Store.ts"

export class ValidationError extends Schema.TaggedError<ValidationError, { readonly brand: unique symbol }>()(
  "ValidationError",
  {
    problems: Schema.Array(Schema.String)
  }
) {}

export const checkReferences = (dataset: Dataset): ReadonlyArray<string> => {
  const problems: Array<string> = []
  const cdrIds = new Map<string, string>()

  for (const [key, card] of dataset.cards) {
    const { issuer } = splitCardKey(key)

    if (!dataset.issuers.has(issuer)) problems.push(`${key}: unknown issuer ${issuer}`)

    const offerPrograms = EffectArray.flatMap(card.offers ?? [], (offer) =>
      EffectArray.flatMap(offer.components, (component) =>
        component.kind === "signup_points" ? [component.program] : []
      )
    )

    for (const id of [card.rewards?.program, ...(card.rewards?.partners ?? []), ...offerPrograms]) {
      if (id !== undefined && !dataset.programs.has(id)) problems.push(`${key}: unknown program ${id}`)
    }

    if (card.cdr !== undefined) {
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
    const { locked: _l, lifecycle, ...stored } = card

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
