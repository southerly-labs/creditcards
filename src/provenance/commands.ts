import { Console, DateTime, Effect, Option, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { splitCardKey, Store, StoreError } from "../store/Store.ts"
import { Card } from "../model/schema.ts"
import { ProvenanceSection, sectionLocks } from "./schema.ts"

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

    if (!card) return yield* new StoreError({ file: key, message: "Unknown card" })

    const reviewed_at = DateTime.formatIso(yield* DateTime.now)

    const updated = yield* Schema.decodeUnknownEffect(Card)({
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

const inspect = Command.make(
  "inspect",
  {},
  Effect.fn(function* () {
    const cards = (yield* (yield* Store).load).cards
    const now = DateTime.toEpochMillis(yield* DateTime.now)

    for (const [key, card] of cards) {
      for (const locked of card.locked ?? []) {
        const section = locked.split(".")[0] ?? locked
        const review = card.provenance?.sections?.[section]
        const parsed = review ? DateTime.make(review.reviewed_at) : Option.none()
        const age = Option.isSome(parsed) ? (now - DateTime.toEpochMillis(parsed.value)) / 86_400_000 : Number.NaN

        if (!Number.isFinite(age) || age >= 90)
          yield* Console.log(
            `${key} ${locked}: ${Number.isFinite(age) ? `${Math.floor(age)} days since review` : "no dated section review"}${review ? ` — ${review.correction_reason}` : ""}`
          )
      }
    }
  })
)

export const provenanceCommand = Command.make("provenance").pipe(Command.withSubcommands([correct, inspect]))
