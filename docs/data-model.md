# Data model and normalization

The canonical schemas are in `src/model/schema.ts`; they define the TOML dataset
storage. The [public API contract](public-api.md) defines public projections and freshness metadata. Money is AUD. Percentages use percent units: `20.99` means 20.99%
p.a. CDR source rates normally use decimal units such as `0.2099`; normalization
accepts the occasional percentage representation too.

## Earn rates

Each earn entry states points per AUD spent. Entries without a category are the
base earn rate, in cumulative spend tiers. A tier applies until its `cap_monthly`
statement-period spend, then the next entry applies. If the last tier has a cap,
spend above it earns nothing. Category entries override the base rate for that
category. The parser accepts only simple base rates or spend tiers; complex,
conditional, category and bonus rates go to human review.

`earn_source` records whether the parser or a person supplied the rates. Manual
rates are never overwritten. `earn_text_hash` records the CDR loyalty text they
were derived from; changed text requests another review. `earn_check` holds issuer
HTML/PDF sources and short expected quotes; matching ignores case and whitespace.

`cents_per_point` is a curated value estimate. Airline programs use a flight
redemption benchmark; bank programs use the airline value divided by the transfer
ratio; retail and cashback programs use their cash value. `value_basis`,
`value_source` and `value_updated` explain the estimate. Browser overrides persist
in localStorage and fall back to defaults when storage cannot be read.

Program aliases are case-insensitive regular expressions matched against CDR
loyalty text. `priority` determines precedence when multiple programs match.
Issuer `cdr_brands` lists the Register brands whose products belong to the issuer.
A card's `locked` entries are dotted paths the automated sync must not overwrite.

## Lifecycle dates

- `first_seen`: the date this project first recorded the card. The sync sets it
  when it adds a card. Cards that existed when the project started have
  2026-10-31; it is not the issuer's launch date.
- `status`: `active`, `closed` (the issuer no longer sells it but still lists it
  in CDR; set by hand and kept by the sync) or `discontinued` (it left CDR).
- `closed`: the date the card closed to new applicants, when known. Allowed with
  status `closed` or `discontinued`.
- `discontinued`: the date the sync saw the card leave CDR. Only with status
  `discontinued`.

`api.json` adds two derived dates under `provenance`: `cdr_observed_at`, the last
successful sync that saw the card (from `data/cdr-observations.toml`), and
`cdr_changed_on`, the date of the newest snapshot in `history/`, which is the last
day the issuer's CDR response changed. `cdr_changed_on` is omitted until a product
has changed at least once since tracking began on 2026-11-01. `cdr.last_updated`
is the issuer's own claim and is not always reliable.

## Signup bonuses

Signup bonuses are offers; see [offers](offers.md). The parser's `signup` offer
lists tranches of points, each paid in `year` 1 or 2 of holding the card. A
first-year tranche usually needs `min_spend` AUD within `spend_days` of approval;
months in the source are stored as 30 days each. A second-year tranche is paid
for keeping the card open `keep_months`, or for spending again around the first
anniversary. `signup_review` works like the earn review metadata, over the CDR
`BONUS_REWARDS` text. Alternative offers, expiring offers and cashback are left
to human review.

## CDR and sync behavior

CDR decoders are deliberately lenient: beyond identifiers, most input fields are
optional and nullable. Fee decoding accepts both old top-level amount/rate fields
and newer fixed-amount/rate-based variants. Mandatory periodic fees are annualized;
daily periodic fees are excluded from annual/monthly card fees. If multiple
applicable foreign transaction rates remain, the highest rate is used.

Some data holders mishandle product-category filtering, so product listings are
fetched without that parameter and filtered locally. Westpac-group caches can
serve stale empty responses for particular Accept/Accept-Encoding combinations;
when active cards are expected, the sync tries the configured header variants.
Version negotiation falls back to probing lower versions after HTTP 406 responses.

A brand leaving the Register or failing its product listing is unknown rather than
empty; it cannot trigger discontinuations. A change only to `cdr.last_updated` is
ignored when computing differences. A rewards table with no program is removed
unless its path is locked. Ownership paths and guardrail thresholds remain in
`src/sync/merge.ts`; the root README describes the hold/review flow.

TOML has no null representation, so undefined optional fields are omitted rather
than assigned. The isolated utility implementing this is documented in
[code-policy.md](code-policy.md).

## Page checks and assets

HTML text extraction removes scripts, styles and comments and separates elements
so adjacent words do not run together. Text matching normalizes Unicode, case,
whitespace, quotes and dashes. PDF extraction suppresses font warnings that do not
affect extracted text. The page check uses an identifying user agent without a URL
because some issuer bot filters reject user agents containing one.

The browser always sorts missing values last, in either direction. Generated site
assets have content-hashed names and a one-year cache lifetime; HTML and API output
keep the default revalidation behavior. See the root README for deployment details.

See [section provenance](provenance.md) for source observations and manual corrections.
Explicit earn rules and calculator assumptions: [earn rules](earn-rules.md).
See [domain validation](domain-validation.md) for cross-field constraints and lock paths.
See [rewards review states](rewards-review.md) for section status and review dates.
See [offers](offers.md) for additive promotions, legacy projection and expiry semantics.
