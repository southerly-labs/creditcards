---
name: verify-manual-overrides
description: Model-check that daily syncs respect hand-maintained card data - locked CDR fields (provenance correct, locked, provenance unlock), explained field gaps, manual signup offers and locked offers. Use before and after changing mergeCard or observeMergedGaps in src/sync/merge.ts, src/machine/fieldGap.ts, src/machine/sectionLock.ts, src/machine/offerSlot.ts, combineOffers or applyOffers in src/offers/build.ts, src/provenance/commands.ts, or proposeCard in src/sync/Sync.ts.
---

# Verify manual overrides survive the sync

## What is verified

**Property.** A daily sync never overwrites a value a maintainer locked, never replaces or removes a manual signup offer or a locked offers list, keeps an explained gap while its field is empty and drops it once CDR fills the field, and a lock never expires on its own.

**Harm if broken.** A maintainer's correction (for example a wrong CDR annual fee they fixed and locked) is silently reverted the next morning and published again.

Rules (TLA+ invariants in `ManualOverrides.tla`):

| Rule                      | Plain words                                                           |
| ------------------------- | --------------------------------------------------------------------- |
| `LockedValueSurvivesSync` | While `fees.annual` is locked, a sync never changes its stored value. |
| `ManualOfferSurvivesSync` | A sync never replaces or removes a `source = "manual"` offer.         |
| `GapKeptWhileFieldEmpty`  | A sync never drops a gap while the field stays empty.                 |
| `NoGapBesideCdrValue`     | A sync never leaves a gap beside a value it took from CDR.            |
| `FrozenOffersUnchanged`   | With `"offers"` locked, a sync never changes the offers.              |
| `AgingNeverUnlocks`       | Ageing a lock (`provenance inspect`) never unlocks it.                |

## Tool and why

TLA+ with TLC 1.7.4 (pinned in `tools/verify/run.sh`), checking every order of maintainer edits, CDR changes and syncs. `tools/verify/overrides-table.ts` runs the real `mergeCard` with `observeMergedGaps` for every lock kind, stored value, CDR value and gap; `combineOffers` for every stored offer, generated offer and offers lock; and `stepLock` for every lock state and event, and writes `ManualOverridesCode.tla`.

## Run it

```sh
bun run verify:overrides
```

About 3 seconds. Output: `holds: <Rule>`, or `BROKEN (NEW): <Rule>` with the shortest path, which fails the run (trace in `.cache/verify/ManualOverrides/tlc-<Rule>.out`). Read traces with the pstack `/statechart` skill, which tells each path in plain words.

## Coverage record

Last confirmed to describe the code at commit `88d79bb5d85ef0eb3433e7742c8799d196656c65` on `main`. If a file below changed after it (`git diff 88d79bb5d85ef0eb3433e7742c8799d196656c65..HEAD -- <files>`), confirm the model still matches, then move the commit forward.

| Model part                                 | Real code                                                                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MergeRows` (generated)                    | `mergeCard`, `isLocked`, `CDR_OWNED_PATHS`, `observeMergedGaps` (`src/sync/merge.ts`); `FieldGapMachine`, `observeGaps` (`src/machine/fieldGap.ts`) |
| `SlotRows` (generated)                     | `combineOffers` (`src/offers/build.ts`); `OfferSlotMachine`, `slotOf`, `offerIn` (`src/machine/offerSlot.ts`)                                       |
| `LockRows` (generated)                     | `SectionLockMachine`, `stepLock` (`src/machine/sectionLock.ts`)                                                                                     |
| `MaintainerCorrects` / `MaintainerUnlocks` | `correct` and `unlock` in `src/provenance/commands.ts`                                                                                              |
| `SyncRuns`                                 | `proposeCard` in `src/sync/Sync.ts`: `mergeCard`, `observeMergedGaps`, then `applyOffers`                                                           |

## Bounds and assumptions

- One CDR-owned field (`fees.annual`), one offer slot (`signup`), at most ten steps. About 7,500 distinct states.
- Hold guardrails on the same field (a vanished `fees.annual` is held) are covered by `verify-sync-holds`, not here.
- A hand value in an unlocked CDR-owned field is overwritten by design; the model checks locked values only.
- Other offers ids, earn rates (protected by review stamps, see `verify-rewards-review`) and the `rewards` deletion when no program is published are out of scope.

## A real bug or a modelling error?

The tables are the real functions' answers, so replay a path by calling `mergeCard`/`observeMergedGaps` and `combineOffers` with the states the path names (`src/offers/build.test.ts` and `test/sync.test.ts` show the inputs). If it does not reproduce, the hand-written `SyncRuns` or a maintainer action is probably wrong; fix the model.

## When the behaviour changes on purpose

Change the code, extend `tools/verify/overrides-table.ts` for new inputs, update the actions if a command changed, rerun, and move the sync commit forward. Never weaken a rule to pass; report a counterexample as a finding. To prove the check can fail, make `slotOf` in `src/machine/offerSlot.ts` stop recognising `source === "manual"`, run, see `ManualOfferSurvivesSync` break, and revert. Use the pstack `/maintain-formal-verification-skill` skill after unchecked changes.
