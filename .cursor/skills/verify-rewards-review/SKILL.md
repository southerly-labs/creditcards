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
| `StampCoversListedText`     | A stamp records the hash of the text the issue listed for that card. **Known finding: broken today** (see below).  |
| `ChangedTextReflagged`      | After a sync read, a `Reviewed` state's hash is the text that sync read; otherwise it is `Stale` and needs review. |
| `ParserNeverReplacesReview` | A sync read never moves `Reviewed` or `Stale` to a parser state.                                                   |
| `UnreadableTextQueued`      | After a sync reads text the parser cannot read, the card needs review unless a person reviewed exactly that text.  |

## Known finding

`StampCoversListedText` breaks. Shortest path: (1) the sync reads text A, which the parser cannot read, and the rewards-review issue lists `bank/card@<hash of A>`; (2) the bank changes its loyalty text to B; (3) a maintainer comments `/earn-none bank/card` without the `@hash`; `parseComment` accepts the bare key, and `stamp` hashes the live text, so the card is stored as `Reviewed` for text B with outcome `none`. Nobody was shown B, and because it is `Reviewed` for B no later sync flags it. With the `@hash` the stamp is refused (`textChanged`). The issue text asks reviewers to keep the `@hash`, but the code does not require it. The finding is listed in `known-findings`, so the run passes while it stays the only broken rule; if you make commands require the hash, delete that line.

## Tool and why

TLA+ with TLC 1.7.4 (pinned in `tools/verify/run.sh`), because the risk is the order of issuer edits, sync reads, issue updates and comments. `tools/verify/review-table.ts` runs the real `stepReview` on every state and event, `needsReview` on every state, and `parseComment` on a bare and a pinned `/earn-none`, and writes `RewardsReviewCode.tla`.

## Run it

```sh
bun run verify:rewards-review
```

About 2 seconds. Output: `holds: <Rule>`, `BROKEN (known finding): StampCoversListedText`, and for anything else `BROKEN (NEW): <Rule>` with the path, which fails the run (trace in `.cache/verify/RewardsReview/tlc-<Rule>.out`). Read traces with the pstack `/statechart` skill, which tells each path in plain words.

## Coverage record

Last confirmed to describe the code at commit `88d79bb5d85ef0eb3433e7742c8799d196656c65` on `main`. If a file below changed after it (`git diff 88d79bb5d85ef0eb3433e7742c8799d196656c65..HEAD -- <files>`), confirm the model still matches, then move the commit forward.

| Model part                                             | Real code                                                                                                                                                                                                                                           |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ReviewRows`, `NeedsReviewRows` (generated)            | `ReviewMachine`, `stepReview`, `needsReview` in `src/machine/review.ts`                                                                                                                                                                             |
| `BareStampAccepted`, `PinnedStampAccepted` (generated) | `parseComment`, `CARD_KEY` in `src/review/commands.ts`                                                                                                                                                                                              |
| `SyncReads`                                            | `earnRead`/`bonusRead` (`src/rewards/state.ts`), `planRewards`/`planBonus` (`src/rewards/plan.ts`), `merged["earn_state"] = stepReview(...)` in `proposeCard` (`src/sync/Sync.ts`), and the rewards-review issue body from `summariseRewardsReview` |
| `MaintainerStamps`                                     | `review-command.yml` → `applyComment` (`src/review/apply.ts`) → `stamp`/`stampBonus` with `stampTarget` and `textChanged` (`src/rewards/review.ts`)                                                                                                 |

## Bounds and assumptions

- One card section, three texts (A unreadable, B parsed, C names no offer), at most nine steps. About 800 distinct states.
- Earn and signup sections share this machine; the model treats them alike. Parsed values (`rewards.earn`, parsed tranches) are not modelled, only the review state.
- `rewards stamp` run locally after `rewards todo` prints the live text is not modelled; the finding concerns issue comments.
- Issuer page quote checks (`earn_check`) are covered by `verify-review-queue`.

## A real bug or a modelling error?

Replay the path with the harness in `test/rewards-stamp.test.ts` (fake `CdrClient`, temp `Store`): seed the card's state, change the fake CDR text, call `applyComment` or `stamp`, and read `earn_state`. The known finding was replayed that way. If a replay does not reproduce, assume the model is wrong and fix it.

## When the behaviour changes on purpose

Change the code, extend `tools/verify/review-table.ts` for new states or events, update `SyncReads` or `MaintainerStamps` if the flow changed, rerun, and move the sync commit forward. Never weaken a rule; add a newly accepted break to `known-findings` only with the user's agreement. To prove the check can fail, make the `Reviewed` state's `Read` resolver always `select.unchanged()` in `src/machine/review.ts`, run, see `ChangedTextReflagged` and `UnreadableTextQueued` break, and revert. Use the pstack `/maintain-formal-verification-skill` skill after unchecked changes.
