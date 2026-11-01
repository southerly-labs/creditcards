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

`bun run cli provenance inspect` reports locks with no section review or a review
at least 90 days old. This is report-only; it never unlocks corrections.
A CDR observation does not reset this age. Source URLs are supplied by the reviewer;
the correction command does not fetch or verify their contents.
