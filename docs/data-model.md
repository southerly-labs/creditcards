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

## Signup bonuses

`rewards.bonus` lists a signup offer as tranches of points, each paid in `year`
1 or 2 of holding the card. A first-year tranche usually needs `min_spend` AUD
within `spend_days` of approval; months in the source are stored as 30 days each.
A second-year tranche is paid for keeping the card open `keep_months`, or for
spending again around the first anniversary. `bonus_source` and
`bonus_text_hash` work like their earn counterparts, over the CDR
`BONUS_REWARDS` text. Alternative offers, expiring offers and cashback are left
to human review. `bonus_points` is the raw CDR value, which is sometimes the
total and sometimes only the first tranche; prefer `bonus` when it is present.

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
