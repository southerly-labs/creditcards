import { BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Array as EffectArray } from "effect"
import { Digest } from "effect/crypto"
import { FetchState, fetched, reportedFailure, settleFetch, stepFetch } from "../../src/machine/brandFetch.ts"
import {
  type CardLifecycle,
  CardLifecycleEvent,
  ListingState,
  SalesState,
  stepLifecycle
} from "../../src/machine/cardLifecycle.ts"
import { MAX_DISCONTINUED_SHARE, MIN_SEEN_SHARE } from "../../src/sync/merge.ts"
import { holdTables } from "./holds-table.ts"
import { tlaConstant, tlaModule, tlaRows } from "./tla.ts"

const TODAY = "2026-11-02"
const EARLIER = "2026-11-01"

const LISTINGS = ["Listed", "Missing", "Delisted"] as const

type Listing = (typeof LISTINGS)[number]

const SALES = ["Selling", "Closed"] as const

type Sales = (typeof SALES)[number]

const listingOf = (tag: Listing, date: string): ListingState => {
  if (tag === "Listed") return ListingState.cases.Listed.make({})

  return tag === "Missing"
    ? ListingState.cases.Missing.make({ since: date })
    : ListingState.cases.Delisted.make({ on: date })
}

const salesOf = (tag: Sales): SalesState =>
  tag === "Selling" ? SalesState.cases.Selling.make({}) : SalesState.cases.Closed.make({ on: EARLIER })

const dateOf = (listing: ListingState): string => {
  if (ListingState.guards.Missing(listing)) return listing.since === TODAY ? "today" : "earlier"

  return ListingState.guards.Delisted(listing) ? (listing.on === TODAY ? "today" : "earlier") : "none"
}

const listingRow = Effect.fn("listingRow")(function* (
  tag: Listing,
  earlier: boolean,
  sales: Sales,
  event: "Seen" | "NotSeen"
) {
  const before: CardLifecycle = { listing: listingOf(tag, earlier ? EARLIER : TODAY), sales: salesOf(sales) }

  const after = yield* stepLifecycle(
    before,
    event === "Seen" ? CardLifecycleEvent.cases.Seen.make({}) : CardLifecycleEvent.cases.NotSeen.make({ date: TODAY })
  )

  return [tag, earlier, sales, event, after.listing._tag, dateOf(after.listing), after.sales._tag]
})

const OUTCOMES = ["ok", "timeout", "http404"] as const

type Outcome = (typeof OUTCOMES)[number]

const listErrorOf = (outcome: Outcome): string | undefined => {
  if (outcome === "ok") return undefined

  return outcome === "timeout" ? "TimeoutError" : "HTTP 404 Not Found"
}

const fetchRow = Effect.fn("fetchRow")(function* (first: Outcome, second: Outcome) {
  const firstState = yield* stepFetch(FetchState.cases.FirstTry.make({}), fetched(listErrorOf(first)))
  const finalState = yield* settleFetch(firstState, listErrorOf(second))

  return [first, second, firstState._tag, finalState._tag, reportedFailure(finalState)]
})

const program = Effect.gen(function* () {
  const listingInputs = EffectArray.flatMap(LISTINGS, (tag) =>
    EffectArray.flatMap([true, false], (earlier) =>
      EffectArray.flatMap(SALES, (sales) =>
        EffectArray.map(["Seen", "NotSeen"] as const, (event) => [tag, earlier, sales, event] as const)
      )
    )
  )

  const listingRows = yield* Effect.forEach(listingInputs, ([tag, earlier, sales, event]) =>
    listingRow(tag, earlier, sales, event)
  )

  const fetchRows = yield* Effect.forEach(
    EffectArray.flatMap(OUTCOMES, (first) => EffectArray.map(OUTCOMES, (second) => [first, second] as const)),
    ([first, second]) => fetchRow(first, second)
  )

  yield* Console.log(
    tlaModule(
      "CardLifecycleCode",
      [
        "src/machine/cardLifecycle.ts",
        "src/machine/brandFetch.ts",
        "src/sync/merge.ts (MIN_SEEN_SHARE, MAX_DISCONTINUED_SHARE)",
        "src/machine/hold.ts",
        "src/sync/holds.ts (resolveHolds)"
      ],
      [
        tlaRows("ListingRows", listingRows),
        tlaRows("FetchRows", fetchRows),
        tlaConstant("MinSeenPct", Math.round(MIN_SEEN_SHARE * 100)),
        tlaConstant("MaxDiscontinuedPct", Math.round(MAX_DISCONTINUED_SHARE * 100)),
        ...(yield* holdTables)
      ]
    )
  )
})

BunRuntime.runMain(program.pipe(Effect.provide(Digest.layerWebCrypto)))
