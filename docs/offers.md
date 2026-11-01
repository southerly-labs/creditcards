# Offers

`card.offers` is an optional collection of independent promotions. Each offer has
one or more `components`: `intro_rate` (percent p.a., optional duration in months),
`fee_discount` (named fee and AUD `payable`, optional duration in months),
`signup_points` (program, points and optional legacy tranche conditions), or
`cash_credit` (AUD amount and optional conditions). Components in one offer belong
together; separate offers must not be assumed stackable. Fee payable is the
resulting fee, not the discount amount. Duration starts according to issuer terms,
not the application window. Unknown conditions remain unknown.

Each offer may carry an `id`, a slug unique within the card, and a `source`:
`cdr` (rebuilt from CDR on each sync), `parser` (rebuilt by the bonus parser) or
`manual` (never touched by the sync; a manual offer replaces a generated one with
the same id). `card.signup_review` records the signup bonus review: `state`
(`present`, `none` or `unknown`), `source` (`parser` or `manual`), the CDR
`text_hash` it was based on, and `reviewed_at` for manual reviews. A manual
`none` means a person confirmed the card has no signup bonus. These fields are
optional while the sync moves over to writing them.

Optional `valid_from` and `valid_until` are real ISO calendar dates, inclusive,
and describe the application window. They do not describe reward payout dates.
`eligibility`, `application_channel` and `conditions` retain source wording.
Missing dates or eligibility are not evidence that an offer is current or available
to everyone. No new source facts or review dates are generated.

`src/offers/project.ts` provides a non-mutating legacy projection. Explicit offers,
including an empty collection, take precedence over all legacy promotions. Otherwise
it projects `rates.intro`, `fees.annual_first_year`, and structured `rewards.bonus`.
It never projects ambiguous `bonus_points`. Each intro rate and first-year fee is a
separate offer; all bonus tranches form one offer. No unsupported association,
validity window or eligibility is inferred. Legacy keys and TOML remain unchanged.

`offerStatus` and `availableOffers` take an explicit ISO date supplied by the caller
in their chosen business timezone. Status is upcoming before the start, expired
after the end, undated when both bounds are absent, and within_window otherwise.
Within-window does not mean eligibility has been verified. Available offers include
undated entries and exclude upcoming/expired entries; callers should label unknown
validity. Expired explicit entries never fall back to legacy data. Nothing is deleted
on expiry, and application-window expiry does not revoke an existing customer's reward.

The build publishes this projection as `offers` on each public card in
`dist/api.json`, omitted when empty. It includes expired explicit offers with
their dates, so consumers must filter with `offerStatus` for their own date.
The legacy keys are still published alongside it. The projection does not change
sync ownership or ingest offers automatically. No schema fields are removed.
