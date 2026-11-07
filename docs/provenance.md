# Section provenance

Successful CDR observations live in `data/cdr-observations.toml`, one
`"issuer/card" = <UTC timestamp>` line per card, rather than in card files, so
the daily sync touches one file instead of every card. The build publishes each
timestamp as `provenance.cdr_observed_at` on the public card. It is separate
from the holder's `cdr.last_updated`. Neither is a human review or a guarantee
that corrected values match CDR.

`sections` maps fees, rates, limits, perks or rewards to `source_urls`,
`reviewed_at` and `correction_reason`. These describe a human's review of the
section, not a fetch performed by a build. Omission means unknown.
No historical dates are inferred. Optional section `observed_at` records an actual
source observation when known; the manual correction command leaves it absent.
Sync records observations only for accepted card updates (including unchanged
cards), not held, failed or missing products. Dry runs write nothing.

After editing a section, run `bun run cli provenance correct issuer/card
--section fees --url https://issuer.example/terms --reason "Explanation"`.
This records the current review and locks the entire section against CDR.
Existing locks are retained. The command supports fees, rates, limits, perks and
rewards. For rewards it locks only the fields CDR owns, `rewards.program` and
`rewards.partners`; earn rates and offers keep their own manual workflow
(`rewards stamp`, `rewards bonus-stamp`, `source = "manual"` offers), so the lock
never blocks the parsers.

Each locked path follows the section lock machine (`src/machine/sectionLock.ts`):
Fresh after a correction, Stale once its section review is 90 days old, or Undated
when its section has no review. `bun run cli provenance inspect` reports stale and
undated locks. It is report-only and never unlocks a path. To hand a path back to
the sync, run `bun run cli provenance unlock issuer/card --path <path>`. The
section's provenance review is kept as history, and the next sync may overwrite
the value from CDR.
A CDR observation does not reset this age. Source URLs are supplied by the reviewer;
the correction command does not fetch or verify their contents.
