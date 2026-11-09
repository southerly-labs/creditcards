---
name: verify-card-lifecycle
description: Model-check how daily CDR syncs move cards between Listed, Missing and Delisted (brand list retries, the CDR outage guard, mass-vanish listing holds, lifecycle locks, sales state). Use before and after changing src/machine/cardLifecycle.ts, src/model/lifecycle.ts, src/machine/brandFetch.ts, the fetch, missing and discontinue logic in src/sync/Sync.ts, or MIN_SEEN_SHARE / MAX_DISCONTINUED_SHARE in src/sync/merge.ts.
---

# Verify the card listing lifecycle

## What is verified

**Property.** A card is marked discontinued only after successful CDR listings of its brand missed it on two different days, never because its brand's product list failed, a CDR outage, or while its lifecycle is locked; when most of a brand vanishes at once each card waits for a maintainer's approval; and a card CDR lists again is back to Listed.

**Harm if broken.** Live cards disappear from the public finder and API (`status = "discontinued"`) because of one bad CDR response.

Rules (TLA+ invariants in `CardLifecycle.tla`):

| Rule                              | Plain words                                                                                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `DelistedOnlyAfterTwoDays`        | A `Delisted` card was missed by successful listings on at least two different days in its current run of misses.                              |
| `DelistedDateIsAMissDay`          | `Delisted.on` is not earlier than the first day of that run of misses.                                                                        |
| `NeverMissingOnFailedFetchOrLock` | A card never leaves `Listed` in a run where its brand's product list failed, or while `locked` has `lifecycle`.                               |
| `MassVanishWaitsForApproval`      | When more than half of a brand's active cards (and more than one) vanish at once, none leaves `Listed` before its listing hold is `Approved`. |
| `SeenCardIsListed`                | After a run that listed the card, it is `Listed`.                                                                                             |
| `SalesUntouchedBySync`            | The sync never changes `lifecycle.sales` (only people set it).                                                                                |

## Tool and why

TLA+ with TLC 1.7.4 (pinned in `tools/verify/run.sh`), because the risk is an order of days, retries and decisions. `tools/verify/lifecycle-table.ts` runs the real `stepLifecycle`, `stepFetch`, `settleFetch`, `reportedFailure`, `resolveHolds` and `stepHold`, and reads `MIN_SEEN_SHARE` and `MAX_DISCONTINUED_SHARE`, and writes them to `CardLifecycleCode.tla`. The run itself (`SyncRuns`) is a hand model of `syncCdr`, cited line by line below.

## Run it

```sh
bun run verify:lifecycle
```

Needs bun, curl, and Java 11+ (or `mise`). About 6 seconds. `holds: <Rule>` means checked; `BROKEN (NEW): <Rule>` fails the run with the shortest path printed and the full trace in `.cache/verify/CardLifecycle/tlc-<Rule>.out`. Read a `BROKEN` trace with the pstack `/statechart` skill, which explains it as a path in plain words.

## Coverage record

Last confirmed to describe the code at commit `88d79bb5d85ef0eb3433e7742c8799d196656c65` on `main`. If a file below changed after that commit (`git diff 88d79bb5d85ef0eb3433e7742c8799d196656c65..HEAD -- <files>`), confirm the model still matches before trusting a pass, then move the commit forward.

| Model part                         | Real code                                                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ListingRows` (generated)          | `CardLifecycleMachine`, `stepLifecycle` in `src/machine/cardLifecycle.ts`; `seen`, `notSeen` in `src/model/lifecycle.ts`                                |
| `FetchRows`, `FailOptions`         | `BrandFetchMachine`, `stepFetch`, `settleFetch` in `src/machine/brandFetch.ts`; `firstPass`, `retried`, `fetched` in `syncCdr`                          |
| `MinSeenPct`, `MaxDiscontinuedPct` | `MIN_SEEN_SHARE`, `MAX_DISCONTINUED_SHARE` in `src/sync/merge.ts`                                                                                       |
| `ResolveRows`, `DecideRows`        | `resolveHolds` (`src/sync/holds.ts`), `stepHold` (`src/machine/hold.ts`), `decideHold`                                                                  |
| `SyncRuns`: abort                  | the `SyncAborted` check (`cardsSeen < activeCdrCards * MIN_SEEN_SHARE`) in `syncCdr`                                                                    |
| `SyncRuns`: seen cards             | `proposeCard` → `withLifecycle(..., seen(existing))`, and `resolveHolds` withdrawing the card's listing hold                                            |
| `SyncRuns`: missed cards           | the `missingByBrand` loop: skips delisted, listed, `lifecycleLocked` and failed-brand cards; `vanished`; the `LISTING_CHANGE` hold candidate; `notSeen` |
| `MaintainerDecides`                | `held approve                                                                                                                                           | reject`/`/approve` on a listing hold |

## Bounds and assumptions

- Brand A has one card (closed to applicants), brand B three cards (one with `locked = ["lifecycle"]`), and ten cards of other brands that only count towards the outage guard (all answer or none do). Four days, unlimited runs per day. About 26,000 distinct states.
- A product whose list entry succeeds but whose detail request fails is not modelled (Sync.ts counts it as listed, so it is never marked missing).
- Brand renames, new cards, the hold race between workflows (see `verify-sync-holds`) and invalid proposals are out of scope.

## A real bug or a modelling error?

Replay the path in `test/sync.test.ts` with `syncOn(day, world)` (it already fakes brand failures, listing changes and `decideHold`), one test step per model action. Violations that come only from the generated tables are very likely real; ones that depend on `SyncRuns` may be a modelling slip in the hand-written run, so check the Sync.ts lines cited above first.

## When the behaviour changes on purpose

Change the code, extend `tools/verify/lifecycle-table.ts` if there is a new state or input, update `SyncRuns` if `syncCdr` changed, rerun, and move the sync commit forward. Never weaken a rule to pass; report a counterexample as a finding instead. To prove the check can fail, change `state.since < event.date` to `<=` in `src/machine/cardLifecycle.ts`, run, see `DelistedOnlyAfterTwoDays` break, and revert. Use the pstack `/maintain-formal-verification-skill` skill to bring the model back in line after unchecked changes.
