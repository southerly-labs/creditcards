# Domain validation

Card decoding checks minimum credit does not exceed maximum credit when both
exist. Counts (intro months, interest-free days, bonus points, spend days and
retention months) must be integers; money and earn rates can be fractional.

Legacy earn tiers are ordered independently by category and by monthly/annual
ceiling. Ceilings must strictly increase; an uncapped tier must be last. A capped
final tier is valid. New earn-rule models should validate their own explicit
scopes rather than flattening rules into legacy tiers.

URLs must be absolute HTTP(S) URLs with a hostname. Calendar dates must be real
YYYY-MM-DD dates; CDR update timestamps require ISO time and an explicit zone.
These checks validate syntax, not source accuracy or freshness.

Lock paths derive from the current card schema, including optional fields and
parent objects. Arrays are locked as a whole, without numeric element paths.
Schema additions automatically become recognized lock targets. Unknown paths
are rejected rather than silently failing to protect a field. Dataset validation
also rejects a known path the sync never writes: a lock must cover a path in
`CDR_OWNED_PATHS` (a parent such as `fees`, or a child such as `cdr.brand`,
which locks the whole `cdr` table), or be exactly `lifecycle` or `offers`.
`rewards.earn` cannot be locked; a manual review stamp protects earn rates.

Checks live at the shared schema boundary used by dataset validation, API
decoding, and sync's existing invalid-record hold path. No source facts or review
dates are inferred or changed.

Review states must agree with the data they describe (`src/build/consistency.ts`).
An `earn_state` of `Parsed`, or `Reviewed`/`Stale` with outcome `present`, needs a
non-empty `rewards.earn`; outcome `none` needs it empty or absent. A
`signup_state` with outcome `present` needs a `manual` offer with id `signup`;
outcome `none` needs no `signup` offer.

Offers with `source = "cdr"` must use an id the sync generates (`intro-purchase`,
`intro-balance-transfer` or `intro-both`, each optionally with a `-2`-style suffix,
`first-year-fee` or `signup`), and `source = "parser"` is only valid on `signup`.
Anything else written by hand must be `source = "manual"`, or the next sync would
treat it as generated and remove it. A `gaps` entry is rejected when its field has
a value: remove the gap when you fill the field by hand.

Stored `provenance` must not contain `cdr_observed_at` or `cdr_changed_on`: the
build derives both, and a stored value would be published as if it had been
observed. Each `provenance.sections` entry must match a lock on the card (its
name is a lock path's first segment, as `provenance correct` writes it), and its
`reviewed_at` and `observed_at` must be a date or an ISO timestamp.

Each entry in `data/sync-holds.toml` must name a change the sync holds (a diffed
card path or `offers.<id>`), store `current` and `proposed` as JSON, carry the id
the sync computes from its card, change and proposed value, and, once decided,
be decided no earlier than its `since` date.
