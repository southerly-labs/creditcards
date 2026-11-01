# Section provenance

Optional `card.provenance` separates successful CDR observation
(`cdr_observed_at`, UTC timestamp) from the holder's `cdr.last_updated`.
Neither is a human review or a guarantee that corrected values match CDR.

`sections` maps fees, rates, limits, perks or rewards to `source_urls`,
`reviewed_at` and `correction_reason`. These describe a human's review of the
section, not a fetch performed by a build. Omission means unknown.
No historical dates are inferred.

After editing a section, run `bun run cli provenance correct issuer/card
--section fees --url https://issuer.example/terms --reason "Explanation"`.
This records the current review and locks the entire section against CDR.
Existing locks are retained. Rewards review stamps remain a separate workflow.

`bun run cli provenance inspect` reports locks with no section review or a review
at least 90 days old. This is report-only; it never unlocks corrections.
A CDR observation does not reset this age. Source URLs are supplied by the reviewer;
the correction command does not fetch or verify their contents.
