import { Effect } from "effect"
import { dual } from "effect/Function"
import {
  type CardLifecycle,
  CardLifecycleEvent,
  flatFromLifecycle,
  initialLifecycle,
  lifecycleFromFlat,
  ListingState,
  stepLifecycle
} from "../machine/cardLifecycle.ts"
import type { Card } from "./schema.ts"

export const lifecycleOf = (card: Card | undefined): CardLifecycle =>
  card === undefined
    ? initialLifecycle
    : (card.lifecycle ?? lifecycleFromFlat({ ...card, status: card.status ?? "active" }))

export const statusOf = (card: Card) => flatFromLifecycle(lifecycleOf(card))

function replaceLifecycle(card: Card, lifecycle: CardLifecycle): Card {
  const { status: _status, closed: _closed, missing_since: _since, discontinued: _on, ...rest } = card

  return { ...rest, lifecycle }
}

export const isDelisted = (card: Card): boolean => ListingState.guards.Delisted(lifecycleOf(card).listing)

export const lifecycleLocked = (card: Card): boolean =>
  (card.locked ?? []).includes("lifecycle") || (card.locked ?? []).includes("status")

export const withLifecycle = dual<
  (lifecycle: CardLifecycle) => (card: Card) => Card,
  (card: Card, lifecycle: CardLifecycle) => Card
>(2, replaceLifecycle)

export const seen = Effect.fn("lifecycle.seen")(function* (existing: Card | undefined) {
  return yield* stepLifecycle(lifecycleOf(existing), CardLifecycleEvent.cases.Seen.make({}))
})

export const notSeen = Effect.fn("lifecycle.notSeen")(function* (card: Card, date: string) {
  return yield* stepLifecycle(lifecycleOf(card), CardLifecycleEvent.cases.NotSeen.make({ date }))
})
