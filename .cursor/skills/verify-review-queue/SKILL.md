---
name: verify-review-queue
description: Model-check the maintainer review queue around an issuer earn page - known_blocked recording, page attention, the rewards-review issue's create/edit/close plan, and open human tasks on the metrics branch. Use before and after changing src/machine/blockedPage.ts, classifyCheck or nextKnownBlocked in src/rewards/check.ts, src/review/tasks.ts, src/review/issue.ts, src/machine/reviewIssue.ts, src/machine/humanTask.ts, tools/sync/record-metrics.sh, or the issue steps in .github/workflows/sync.yml.
---

# Verify the review queue

## What is verified

**Property.** Every change in an issuer earn page's status (starts failing, fails differently, reads again) is raised for review on the first run that sees it, a standing block stays quiet, the rewards-review issue is open exactly while work remains, and a human task keeps its first-seen date and survives runs whose page report is missing.

**Harm if broken.** A maintainer misses a page that changed or broke, gets nagged daily about a known block, or the autonomy metrics (`open_human_tasks`, `tasks_opened_today`) count the same task as new again.

Rules (TLA+ invariants in `ReviewQueue.tla`):

| Rule                               | Plain words                                                                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `EveryPageChangeRaised`            | In a run whose page check succeeded, a page status different from the last checked run needs review.                             |
| `StandingBlockStaysQuiet`          | The same failure as last checked run, blocked for under 30 days, does not need review.                                           |
| `IssueOpenExactlyWhileWorkRemains` | After a checked run the rewards-review issue is open iff the page is unreadable, the page needs review, or other items are open. |
| `TaskKeepsFirstDay`                | An open page task's `since` is the first run of its current stretch.                                                             |
| `FailedCheckKeepsTasks`            | A run without a page report never closes an open task.                                                                           |

## Tool and why

TLA+ with TLC 1.7.4 (pinned in `tools/verify/run.sh`): the risk is the order of page changes, failed check steps and month-long blocks across runs. `tools/verify/queue-table.ts` runs the real `classifyCheck`, `nextKnownBlocked`, `pageNeedsReview`, `rewardsIssueEvent` with `planIssue`, and `openHumanTasks` on every abstract input, and writes `ReviewQueueCode.tla`.

## Run it

```sh
bun run verify:review-queue
```

About 6 seconds. Output: `holds: <Rule>`, or `BROKEN (NEW): <Rule>` with the shortest path, which fails the run (trace in `.cache/verify/ReviewQueue/tlc-<Rule>.out`). Read traces with the pstack `/statechart` skill, which tells each path in plain words.

## Coverage record

Last confirmed to describe the code at commit `88d79bb5d85ef0eb3433e7742c8799d196656c65` on `main`. If a file below changed after it (`git diff 88d79bb5d85ef0eb3433e7742c8799d196656c65..HEAD -- <files>`), confirm the model still matches, then move the commit forward.

| Model part                 | Real code                                                                                                                                                                                                                                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ClassifyRows` (generated) | `classifyCheck`, `nextKnownBlocked`, `pageEvent` (`src/rewards/check.ts`); `BlockedPageMachine`, `stepPage`, `pageAttention` (`src/machine/blockedPage.ts`); `pageNeedsReview`, `reviewOpenCount` (`src/review/tasks.ts`)                                                                                        |
| `IssueRows` (generated)    | `rewardsIssueEvent` (`src/review/issue.ts`), `ReviewIssueMachine`, `planIssue`, `issueAction` (`src/machine/reviewIssue.ts`)                                                                                                                                                                                     |
| `TaskRows` (generated)     | `openHumanTasks`, `withLifecycle`, `observedTasks` (`src/review/tasks.ts`); `HumanTaskMachine` (`src/machine/humanTask.ts`)                                                                                                                                                                                      |
| `SyncRuns`                 | `sync.yml`: "Check issuer earn pages" (`rewards check --record-blocked`, `recordBlockedCheck` in `src/cli.ts`, continue-on-error), "Update earn-rate review issue" (`--checked` only on success, `gh issue create/edit/close`), "Record daily autonomy metrics" (`tools/sync/record-metrics.sh`, `review tasks`) |

## Bounds and assumptions

- One page, two distinct errors, one other review item that comes and goes, days up to 34 (a month can pass in one step so the 30-day rule is reached). About 175,000 distinct states.
- When the check step fails, the model assumes nothing was recorded on the card that run.
- A task whose reason changes while open (for example `unreadable_page` to `blocked_page_changed`) gets a new `since` in the real code; the generated task table fixes the reason, so that reset is not modelled.
- The sync-held issue uses the same `planIssue` with `checked = true`; it is not modelled separately. Issue label edits by hand, the webhook fingerprint, and `gh` failures are out of scope.

## A real bug or a modelling error?

Replay the path with the real functions: `classifyCheck`/`nextKnownBlocked` from `src/rewards/check.ts`, then `openHumanTasks` and `planIssue` with the previous run's output, one step per model action (`test/rewards-check.test.ts` and `test/review-issue.test.ts` show the inputs). A path through `SyncRuns` may also be a slip in the hand-written workflow model; check the `sync.yml` step conditions first.

## When the behaviour changes on purpose

Change the code, extend `tools/verify/queue-table.ts` for new inputs, update `SyncRuns` if the workflow changed, rerun, and move the sync commit forward. Never weaken a rule to pass; report a counterexample as a finding. To prove the check can fail, remove the "Blocked page status changed" branch of `pageAttention` in `src/machine/blockedPage.ts`, run, see `EveryPageChangeRaised` break, and revert. Use the pstack `/maintain-formal-verification-skill` skill after unchecked changes.
