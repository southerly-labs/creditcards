---
name: verify-rewards-review
description: Model-check the earn rate and signup bonus review states (earn_state, signup_state) as issuer CDR text changes, the sync reads it, and maintainers stamp it from the rewards-review issue. Use before and after changing src/machine/review.ts, src/rewards/state.ts, src/rewards/plan.ts, stamp or stampBonus in src/rewards/review.ts, src/review/commands.ts, src/review/apply.ts, or how src/sync/Sync.ts feeds Read events to the review statechart.
---

# Verify the rewards review states

## What is verified

**Property.** A maintainer's review stamp only ever covers CDR text the rewards-review issue showed them; when the issuer changes that text the card goes back on the review list; the parser never overwrites a manual review; and text the parser cannot read is always queued for review.

**Harm if broken.** The site publishes "no fixed earn rate" or "no signup offer" as reviewed for text nobody read, or silently keeps a stale manual earn rate after the bank changed its offer.

Rules (TLA+ invariants in `RewardsReview.tla`):

| Rule                        | Plain words                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `StampCoversListedText`     | A stamp records the hash of the text the issue listed for that card.                                               |
| `ChangedTextReflagged`      | After a sync read, a `Reviewed` state's hash is the text that sync read; otherwise it is `Stale` and needs review. |
| `ParserNeverReplacesReview` | A sync read never moves `Reviewed` or `Stale` to a parser state.                                                   |
| `UnreadableTextQueued`      | After a sync reads text the parser cannot read, the card needs review unless a person reviewed exactly that text.  |

## Past finding

`StampCoversListedText` used to break: (1) the sync reads text A, which the parser cannot read, and the rewards-review issue lists `bank/card@<hash of A>`; (2) the bank changes its loyalty text to B; (3) a maintainer comments `/earn-none bank/card` without the `@hash`, and the card was stored as `Reviewed` for B, which nobody was shown. Since commit `896add3` the review command reads the issue body (`--issue-file`), `applyComment` pins a bare card to the hash the issue listed (`listedHashes` in `src/review/listed.ts`), and `stamp` refuses it through `textChanged` when the live text differs. `test/review-earn-none.test.ts` replays the path for `/earn-none` and `/bonus-none`. `known-findings` is empty, so a regression fails the run.

## Tool and why

TLA+ with TLC 1.7.4 (pinned in `tools/verify/run.sh`), because the risk is the order of issuer edits, sync reads, issue updates and comments. `tools/verify/review-table.ts` runs the real `stepReview` on every state and event, `needsReview` on every state, `parseComment` on a bare and a pinned `/earn-none`, and the real `applyComment` (temp `Store`, fake `CdrClient`, issue body from `summariseRewardsReview`) on a bare and a pinned `/earn-none` with the listed text unchanged and changed, and writes `RewardsReviewCode.tla`.

## Run it

```sh
bun run verify:rewards-review
```

About 2 seconds. Output: `holds: <Rule>`, or `BROKEN (NEW): <Rule>` with the path, which fails the run (trace in `.cache/verify/RewardsReview/tlc-<Rule>.out`). Read traces with the pstack `/statechart` skill, which tells each path in plain words.

## Coverage record

Last confirmed to describe the code at commit `895c2ee571345f953496dec12810ade9d409484b` on `main`. If a file below changed after it (`git diff 895c2ee571345f953496dec12810ade9d409484b..HEAD -- <files>`), confirm the model still matches, then move the commit forward.

| Model part                                             | Real code                                                                                                                                                                                                                                           |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ReviewRows`, `NeedsReviewRows` (generated)            | `ReviewMachine`, `stepReview`, `needsReview` in `src/machine/review.ts`                                                                                                                                                                             |
| `BareStampAccepted`, `PinnedStampAccepted` (generated) | `parseComment`, `CARD_KEY` in `src/review/commands.ts`                                                                                                                                                                                              |
| `StampLandsRows` (generated)                           | `applyComment`, `pinToListed` (`src/review/apply.ts`), `listedHashes` (`src/review/listed.ts`), `stamp`, `textChanged` (`src/rewards/review.ts`), the issue body from `summariseRewardsReview` (`src/sync/Sync.ts`)                                 |
| `SyncReads`                                            | `earnRead`/`bonusRead` (`src/rewards/state.ts`), `planRewards`/`planBonus` (`src/rewards/plan.ts`), `merged["earn_state"] = stepReview(...)` in `proposeCard` (`src/sync/Sync.ts`), and the rewards-review issue body from `summariseRewardsReview` |
| `MaintainerStamps`                                     | `review-command.yml` (`--issue-file` with the issue body) → `applyComment` (`src/review/apply.ts`) → `stamp`/`stampBonus` with `stampTarget` and `textChanged` (`src/rewards/review.ts`)                                                            |

## Bounds and assumptions

- One card section, three texts (A unreadable, B parsed, C names no offer), at most nine steps. About 800 distinct states.
- Earn and signup sections share this machine; the model treats them alike. Parsed values (`rewards.earn`, parsed tranches) are not modelled, only the review state.
- `rewards stamp` run locally after `rewards todo` prints the live text is not modelled; the rule concerns issue comments. A bare comment on a card the issue does not list is not pinned and is not modelled.
- `StampLandsRows` is built for `/earn-none`; `/bonus-none` takes the same path through `stampBonus` and is covered by `test/review-earn-none.test.ts`.
- Issuer page quote checks (`earn_check`) are covered by `verify-review-queue`.

## A real bug or a modelling error?

Replay the path with the harness in `test/rewards-stamp.test.ts` (fake `CdrClient`, temp `Store`): seed the card's state, change the fake CDR text, call `applyComment` or `stamp`, and read `earn_state`. The old StampCoversListedText finding was replayed that way. If a replay does not reproduce, assume the model is wrong and fix it.

## When the behaviour changes on purpose

Change the code, extend `tools/verify/review-table.ts` for new states or events, update `SyncReads` or `MaintainerStamps` if the flow changed, rerun, and move the sync commit forward. Never weaken a rule; add a newly accepted break to `known-findings` only with the user's agreement. To prove the check can fail, make `pinnedTarget` in `src/review/apply.ts` return the bare card, run, and see `StampCoversListedText` break; or make the `Reviewed` state's `Read` resolver always `select.unchanged()` in `src/machine/review.ts`, run, see `ChangedTextReflagged` and `UnreadableTextQueued` break, and revert. Use the pstack `/maintain-formal-verification-skill` skill after unchecked changes.
