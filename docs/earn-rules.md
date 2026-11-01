# Explicit earn rules

Optional rewards.earn_rules preserves rewards.earn and its cumulative legacy tiers.
Each rule states points per AUD, a treatment (replacement total rate or additional
points added to a replacement rate), and a category with a stable slug ID and
source-grounded description. The reserved ID general means eligible general
purchases. Other IDs identify source-defined categories; descriptions define their
scope rather than implying a universal merchant classification.

A cap has an amount, unit (AUD spend or earned points), and reset period:
statement, calendar-month, calendar-year or membership-year. It limits that
rule's contribution, with zero contribution above the limit. shared_group names
a pool shared across rules; it is not an independent cap per category. Conflicting
pool definitions must be resolved from source terms before use.

The annual calculator prefers explicit rules when present. It supports exactly
one general replacement rule plus general additional rules, with independent
spend or points caps. It assumes equal monthly eligible spending, twelve equal
statement periods and one complete annual period, with no transaction rounding.
Category allocation, shared pools and multiple replacement tiers need more
inputs: these return unknown, including when legacy rates coexist, rather than
silently showing an optimistic estimate. Legacy-only records retain existing
calculation behavior. Category descriptions, not guessed keyword mappings, must
guide future category-aware consumers.

No existing prose is automatically migrated and no review dates are invented.
