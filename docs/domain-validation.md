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
are rejected rather than silently failing to protect a field.

Checks live at the shared schema boundary used by dataset validation, API
decoding, and sync's existing invalid-record hold path. No source facts or review
dates are inferred or changed.
