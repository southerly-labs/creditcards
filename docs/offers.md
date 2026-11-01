# Offers

`card.offers` holds a card's promotions: intro rates, first-year fee discounts and
signup bonuses. Each offer has one or more `components`: `intro_rate` (percent p.a.,
optional duration in months), `fee_discount` (named fee and AUD `payable`, optional
duration in months), `signup_points` (program and points, with optional `year`,
`min_spend`, `spend_days`, `keep_months` and `note`), or `cash_credit` (AUD amount
and optional conditions). Components in one offer belong together; separate offers
must not be assumed stackable. Fee payable is the resulting fee, not the discount
amount. Duration starts according to issuer terms, not the application window.
Unknown conditions remain unknown.

## Ids and sources

Every offer has an `id`, a slug unique within the card, and a `source`:

- `cdr`: rebuilt from CDR on every sync. Intro rates get `intro-purchase`,
  `intro-balance-transfer` or `intro-both` (with `-2`, `-3` for repeats), the
  first-year annual fee gets `first-year-fee`, and the raw CDR bonus total gets
  `signup`.
- `parser`: the `signup` offer written by the bonus parser, one `signup_points`
  component per tranche, each with a `year`.
- `manual`: written by a person and never touched by the sync. A manual offer
  replaces a generated one with the same `id`, in the same position.

Generated offers the sync no longer produces are dropped. Adding `"offers"` to a
card's `locked` list freezes the whole list.

The raw CDR bonus total is ambiguous: it is sometimes the full bonus and sometimes
only the first tranche. It is written as a `cdr` signup offer with no `year` only
when no parser or manual signup offer exists and no review says there is no bonus.
Consumers should show it as an unsplit total and not count it as a first-year bonus.

## Signup review

`card.signup_review` records the last assessment of the signup bonus: `state`
(`present`, `none` or `unknown`), `source` (`parser` or `manual`), the CDR
`text_hash` it was based on, and `reviewed_at` for manual reviews. Parser success
writes `present`; a parsed bonus the parser can no longer read, or whose offer
ended, becomes `unknown`. `bun run cli rewards bonus-stamp` marks the hand-written
signup offer `manual` and records `present`, or with `--none` removes the signup
offer and records `none`. A manual `none` means a person confirmed the card has no
current points signup offer, so the raw total is not shown either. When the CDR
text hash no longer matches a manual review, the card returns to the review queue.

## Validity

Optional `valid_from` and `valid_until` are real ISO calendar dates, inclusive,
and describe the application window. They do not describe reward payout dates.
`eligibility`, `application_channel` and `conditions` retain source wording.
Missing dates or eligibility are not evidence that an offer is current or available
to everyone.

`offerStatus` in `src/offers/project.ts` takes an explicit ISO date supplied by the
caller in their chosen business timezone. Status is upcoming before the start,
expired after the end, undated when both bounds are absent, and within_window
otherwise. Within-window does not mean eligibility has been verified. Nothing is
deleted on expiry, and application-window expiry does not revoke an existing
customer's reward.

The build publishes stored offers unchanged on each public card in
`dist/api.json`, including expired ones with their dates, so consumers must filter
with `offerStatus` for their own date.
