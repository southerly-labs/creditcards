import { Console, DateTime, Effect, Array as EffectArray, Option, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { splitCardKey, Store, StoreError } from "../store/Store.ts"
import { Card } from "../model/schema.ts"
import { ProvenanceSection, sectionLocks } from "./schema.ts"
import { LockEvent, LockState, lockSection, lockStateOf, stepLock } from "../machine/sectionLock.ts"

const correct = Command.make(
  "correct",
  {
    key: Argument.String("card"),
    section: Flag.String("section"),
    url: Flag.String("url"),
    reason: Flag.String("reason")
  },
  Effect.fn(function* ({ key, section, url, reason }) {
    const selected = yield* Schema.decodeUnknownEffect(ProvenanceSection)(section)
    const store = yield* Store
    const card = (yield* store.load).cards.get(key)

    if (card === undefined) return yield* StoreError.make({ file: key, message: "Unknown card" })

    const reviewed_at = DateTime.formatIso(yield* DateTime.now)

    const updated = yield* Schema.decodeEffect(Card)({
      ...card,
      locked: [...new Set([...(card.locked ?? []), ...sectionLocks(selected)])],
      provenance: {
        ...card.provenance,
        sections: {
          ...card.provenance?.sections,
          [selected]: { source_urls: [url], reviewed_at, correction_reason: reason }
        }
      }
    })

    const parts = splitCardKey(key)
    yield* store.writeCard(parts.issuer, parts.card, updated)
    yield* Console.log(`Recorded review and locked ${key} ${selected}`)

    return undefined
  })
)

const unlock = Command.make(
  "unlock",
  { key: Argument.String("card"), path: Flag.String("path") },
  Effect.fn(function* ({ key, path }) {
    const store = yield* Store
    const card = (yield* store.load).cards.get(key)

    if (card === undefined) return yield* StoreError.make({ file: key, message: "Unknown card" })
    const state = yield* stepLock(lockStateOf(card, path), LockEvent.cases.Unlock.make({}))

    if (!LockState.guards.Unlocked(state) || !(card.locked ?? []).includes(path))
      return yield* StoreError.make({ file: key, message: `${path} is not locked` })
    const { locked: _locked, ...rest } = card
    const locked = EffectArray.filter(card.locked ?? [], (entry) => entry !== path)
    const parts = splitCardKey(key)

    yield* store.writeCard(parts.issuer, parts.card, locked.length === 0 ? rest : { ...rest, locked })
    yield* Console.log(`Unlocked ${key} ${path}; the next sync may overwrite it from CDR`)

    return undefined
  })
).pipe(Command.withDescription("Release a locked path so the sync owns it again (its provenance review is kept)"))

const inspect = Command.make(
  "inspect",
  {},
  Effect.fn(function* () {
    const cards = (yield* (yield* Store).load).cards
    const current = yield* DateTime.now
    const now = DateTime.formatIso(current)
    const nowMs = DateTime.toEpochMillis(current)

    for (const [key, card] of cards) {
      for (const path of card.locked ?? []) {
        const state = yield* stepLock(lockStateOf(card, path), LockEvent.cases.Aged.make({ now }))
        const review = card.provenance?.sections?.[lockSection(path)]

        if (LockState.guards.Undated(state)) yield* Console.log(`${key} ${path}: no dated section review`)

        if (LockState.guards.Stale(state)) {
          const age = Option.match(DateTime.make(state.reviewed_at), {
            onNone: () => "an unreadable review date",
            onSome: (at) => `${Math.floor((nowMs - DateTime.toEpochMillis(at)) / 86_400_000)} days since review`
          })

          yield* Console.log(`${key} ${path}: ${age}${review === undefined ? "" : ` — ${review.correction_reason}`}`)
        }
      }
    }
  })
)

export const provenanceCommand = Command.make("provenance").pipe(Command.withSubcommands([correct, unlock, inspect]))
