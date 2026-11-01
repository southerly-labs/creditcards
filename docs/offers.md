# Offers

`card.offers` is an optional collection of independent promotions. Each offer has
one or more `components`: `intro_rate` (percent p.a., optional duration in months),
`fee_discount` (named fee and AUD `payable`, optional duration in months),
`signup_points` (program, points and optional legacy tranche conditions), or
`cash_credit` (AUD amount and optional conditions). Components in one offer belong
together; separate offers must not be assumed stackable. Fee payable is the
resulting fee, not the discount amount. Duration starts according to issuer terms,
not the application window. Unknown conditions remain unknown.

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

This module does not change sync ownership, ingest offers automatically, or alter
existing web calculations. Consumers can opt into the projection without double
counting legacy fields. No schema fields are removed.
