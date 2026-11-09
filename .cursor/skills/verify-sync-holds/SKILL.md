---
name: verify-sync-holds
description: Model-check the sync hold lifecycle (held changes, /approve and /reject decisions, and the git rebase between the sync and review-command workflows). Use before and after changing src/machine/hold.ts, src/sync/holds.ts, the hold handling in src/sync/Sync.ts, src/sync/heldCommand.ts, src/review/apply.ts, or the commit and push steps of .github/workflows/sync.yml or review-command.yml.
---

# Verify the sync hold lifecycle

## What is verified

**Property.** A guarded change (a big fee or rate jump, a vanished key field, a changed signup offer) reaches a card only after a maintainer approved that exact value, or after CDR showed the same change again on a later day; a rejected value never lands; and a recorded decision is never lost, even when the sync and a review comment race to push.

**Harm if broken.** The public data silently publishes a wrong fee or rate that a maintainer never saw, or a maintainer's `/reject` is undone by the next sync.

Rules (TLA+ invariants in `SyncHolds.tla`):

| Rule                       | Plain words                                                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NoUnreviewedApply`        | A sync only changes the guarded field to a value whose hold was `Approved`, or whose hold was pending from an earlier day and is now confirmed by CDR (`kind = "confirm"`). |
| `RejectedValueNeverStored` | The card never holds a value whose hold is `Rejected`.                                                                                                                      |
| `DecisionNeverLost`        | A landed push never turns an `Approved` or `Rejected` hold back into a pending one.                                                                                         |
| `ApprovedValueApplied`     | A sync that reads an `Approved` hold while CDR still shows that value applies it.                                                                                           |
| `OneHoldPerField`          | `data/sync-holds.toml` never has two holds for the same card field.                                                                                                         |

## Tool and why

TLA+ with TLC 1.7.4 (pinned with its SHA-256 in `tools/verify/run.sh`). The question is whether events in a bad order (two workflows, daily runs, a human decision in between) can break a rule, which is what a model checker answers. The model does not re-implement the hold logic: `tools/verify/holds-table.ts` runs the real `resolveHolds` and `stepHold` on every abstract input and writes the results to `SyncHoldsCode.tla`, which the model reads. A change to the real code changes the table, so the check can fail on it.

## Run it

```sh
bun run verify:holds
```

Needs bun, curl, and Java 11 or later on `PATH` (or `mise`, which installs `java@temurin-25`). The first run downloads `tla2tools.jar` into `~/.cache/creditcards-verify/`. The run takes about 20 seconds. Output lines:

- `holds: <Rule>` — checked over the whole bounded model.
- `BROKEN (NEW): <Rule>` — the run fails. The shortest path is printed as action names; the full trace is in `.cache/verify/SyncHolds/tlc-<Rule>.out`.
- `BROKEN (known finding)` — a rule listed in `known-findings` (none for this model).

Read any `BROKEN` trace with the pstack `/statechart` skill: it explains the shortest path in plain words and draws the states.

## Coverage record

Last confirmed to describe the code at commit `88d79bb5d85ef0eb3433e7742c8799d196656c65` on `main`. If any file below changed after that commit (`git diff 88d79bb5d85ef0eb3433e7742c8799d196656c65..HEAD -- <files>`), check that the model still matches before trusting a pass. Move this commit forward only after you have confirmed that.

| Model part                     | Real code                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ResolveRows` (generated)      | `resolveHolds`, `newHold`, `heldAs`, `holdId` in `src/sync/holds.ts`; `HoldMachine`, `stepHold` in `src/machine/hold.ts`                                      |
| `DecideRows` (generated)       | `stepHold` with `Approve`/`Reject`, as called by `decideHold` in `src/sync/heldCommand.ts`                                                                    |
| `SyncStarts`                   | `sync.yml` checks out `main`; `syncCdr` loads the store and `holdCandidates`; `withCdrEvidence` picks `approve` or `confirm` (`src/sync/holds.ts`)            |
| `SyncLands`                    | `resolveHolds` per card, `revertChange`, `store.writeHolds` (`src/sync/Sync.ts`), then the "Commit to main" retry loop with `git pull --rebase` in `sync.yml` |
| `ReviewStarts` / `ReviewLands` | `review-command.yml`: `applyComment` (`src/review/apply.ts`) → `decideHold`, then its commit and rebase loop                                                  |
| `Merge`, `Clash`               | `git pull --rebase` on `data/sync-holds.toml`, at the granularity of one `[[hold]]` entry                                                                     |
| `issue`                        | the "Report held changes" step listing pending holds                                                                                                          |

## Bounds and assumptions

- One card field, three values (`v0` stored, `v1`, `v2` from CDR), three days, at most one sync run and one review run in flight (the `sync` concurrency group serialises sync runs). About 615,000 distinct states.
- Every change of the field is a guarded one (it always makes a hold candidate). Unguarded changes apply directly and are out of scope.
- `withCdrEvidence` is free to answer `approve` or `confirm` on each run; the PLAUSIBLE ranges and snapshot comparison are not modelled.
- A rebase conflicts only when both sides changed the same hold entry (or the card). Real git can also conflict on neighbouring lines and can reorder entries; extra conflicts only fail the run, so they are safe, but a git merge that moves entries is not modelled.
- Not covered: offers holds' `revertOffer` details, `REVERTED_WITH` (earn rates revert with `earn_state`), the listing hold for vanished cards (see `verify-card-lifecycle`), and the issue text.

## A real bug or a modelling error?

Replay the printed path against the real code before you call it a bug: the sync tests in `test/sync.test.ts` (`syncOn`, `decideHold`) can drive each step, one test step per model action. The generated tables are the real code's answers, so a violation that uses only `SyncStarts`, `SyncLands` and the tables is very likely real. If the path needs a git merge outcome, check it with two commits in a scratch repo. If the replay does not reproduce, assume the model is wrong until you show otherwise, and fix the model (not the rule).

## When the behaviour changes on purpose

1. Change the code. The tables regenerate on every run.
2. If the change adds a new state, event or input that the extractor does not enumerate, extend `tools/verify/holds-table.ts`.
3. If the workflow steps change, update the matching action in `SyncHolds.tla`.
4. Rerun, and confirm each rule still says what a maintainer wants. Never weaken a rule to get a pass; if the current code breaks it, report the counterexample as a finding.
5. Move the sync commit above forward.

To prove the check can still fail, break the code on purpose (for example make `AwaitingApproval` answer `select.apply()` for an `approve` proposal in `src/machine/hold.ts`), run it, see `NoUnreviewedApply` break, and revert. For bringing the model back in line after changes that skipped this check, use the pstack `/maintain-formal-verification-skill` skill.
