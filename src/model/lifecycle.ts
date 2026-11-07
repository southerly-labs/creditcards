import { Effect } from "effect"
import { dual } from "effect/Function"
import {
  type CardLifecycle,
  CardLifecycleEvent,
  flatFromLifecycle,
  initialLifecycle,
  ListingState,
  stepLifecycle
} from "../machine/cardLifecycle.ts"
import type { Card } from "./schema.ts"

export const lifecycleOf = (card: Card | undefined): CardLifecycle => card?.lifecycle ?? initialLifecycle

export const statusOf = (card: Card) => flatFromLifecycle(lifecycleOf(card))

const replaceLifecycle = (card: Card, lifecycle: CardLifecycle): Card => ({ ...card, lifecycle })

export const isDelisted = (card: Card): boolean => ListingState.guards.Delisted(lifecycleOf(card).listing)

export const lifecycleLocked = (card: Card): boolean => (card.locked ?? []).includes("lifecycle")

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
