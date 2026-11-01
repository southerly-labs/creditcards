<img src="assets/icon.svg" width="64" height="64" alt="">

# creditcards

An open database of Australian credit cards: fees, interest rates, foreign transaction fees, rewards programs and more, in the spirit of [models.dev](https://models.dev).

Most data comes from the Consumer Data Right (CDR) [product reference data](https://consumerdatastandardsaustralia.github.io/standards/#get-products) that every Australian bank and non-bank lender must publish. A daily GitHub Action pulls it, normalises it into TOML under `data/`, and commits the changes to `main`.

## Data layout

```
data/
  programs/<program>.toml              loyalty programs (aliases match CDR text)
  issuers/<issuer>/issuer.toml         issuer name and the CDR brands it covers
  issuers/<issuer>/cards/<card>.toml   one file per card

history/
  cdr/<issuer>/<product_id>/<date>.json   raw CDR product response, saved on the days it changed
```

The sync writes `history/` and nothing else does. A snapshot is saved only when the response differs from the product's latest one (keys are sorted first, and a different negotiated API `version` alone doesn't count), so each file marks a change the issuer published. Folders are keyed by issuer slug, so moving a brand to another issuer starts a new folder. The files keep the raw response rather than the normalised card, so a timeline can be rebuilt with the current normalisers and a parser fix never shows up as a change.

The schema lives in `src/model/schema.ts`. Percentages are stored as percent (`20.99`) and money in AUD.

### Editing data by hand

The CDR sync only owns the fields listed in `CDR_OWNED_PATHS` (`src/sync/merge.ts`); earn rates are handled separately (see below). To stop the sync from overwriting a CDR-derived field you have corrected, add it to `locked`:

```toml
locked = ["fees.foreign_txn_pct"]
```

### Earn rates

Banks publish earn rates as prose, so they are filled in two ways:

- **Parser.** During the sync, a conservative rule-based parser (`src/rewards/parse.ts`) sets `rewards.earn` for simple cases: a single rate or spend tiers. These cards have `earn_source = "parser"`.
- **Review.** Everything else (category rates, bonuses, exclusions, cashback) is listed in the `rewards-review` issue. Resolve it locally, by hand or in a Claude Code session:

  ```sh
  bun run cli rewards todo --issuer anz          # cards to review, with their CDR text
  # edit rewards.earn in the card's TOML file
  bun run cli rewards stamp anz/business-black   # mark it reviewed (--none if no fixed rate)
  ```

  Stamped cards have `earn_source = "manual"` and are never overwritten. If the bank's loyalty text changes, the card goes back on the review list.

- **Issuer pages.** Some cards' CDR text has no earn rate, so the rate was read from the issuer's own page or terms PDF. These cards list that source under `rewards.earn_check`, with short quotes of the earn wording:

  ```toml
  [[rewards.earn_check]]
  url = "https://www.qantasmoney.com/credit-cards/everyday"
  expect = ["0.75 qantas points per whole au$1 on domestic spend up to and including au$3,000 each statement period"]
  ```

  After each sync, `bun run cli rewards check` fetches every source and lists cards whose quotes no longer appear in the `rewards-review` issue. Matching ignores case and whitespace. The check is report-only and needs no LLM. When a card is flagged, re-read the page, update `earn` and `expect`, and stamp the card again. To pick quotes, use `bun run cli rewards check --show <url>`, which prints the same normalised text the check searches.

### Signup bonuses

Signup bonuses, intro rates and first-year fee discounts are stored as `[[offers]]` (see [docs/offers.md](docs/offers.md)). Each offer has an `id` and a `source`: `cdr` and `parser` offers are rebuilt by every sync, and `manual` offers are never touched. A manual offer replaces a generated one with the same `id`. Bonus offers are often paid in two parts, so the signup offer holds one `signup_points` component per tranche:

```toml
[[offers]]
id = "signup"
source = "parser"

[[offers.components]]
kind = "signup_points"
program = "qantas"
points = 80000
year = 1
min_spend = 3000
spend_days = 90

[[offers.components]]
kind = "signup_points"
program = "qantas"
points = 20000
year = 2
keep_months = 12
```

- **Parser.** During the sync, `src/rewards/bonus.ts` reads the CDR `BONUS_REWARDS` text. It writes a `parser` signup offer only when every amount maps to a clear year and the amounts agree with any "up to" total and with the CDR value. When the offer ends, or changes into text the parser can't read, the parsed offer is removed rather than left stale.
- **Raw total.** When nothing better is known, the sync writes the CDR bonus total as a `cdr` signup offer with no `year`. It is sometimes the total and sometimes only the first part, so the site shows it as "split unknown" and never counts it as a first-year bonus.
- **Review.** Alternative offers, end dates, cashback, per-month awards and offers with no details in CDR are listed in the `rewards-review` issue:

  ```sh
  bun run cli rewards bonus-todo --issuer anz      # cards to review, with their CDR bonus text
  # write the [[offers]] entry with id = "signup" in the card's TOML file
  bun run cli rewards bonus-stamp anz/rewards-platinum   # --none if there is no current points offer
  ```

  Stamping marks the signup offer `manual` and records `signup_review` (`state`, `source = "manual"`, the CDR text hash and the date). `--none` records `state = "none"` and removes the signup offer, so the raw CDR total is not shown either. If the bank's bonus text changes, the card goes back on the review list.

To freeze all of a card's offers, add `"offers"` to its `locked` list.

No LLM runs in CI and no API key is needed.

### Sync guardrails

Updates auto-merge. Changes that look wrong are held back and reported in a `sync-held` issue instead:

- the whole run aborts if far fewer cards come back than are active (likely outage)
- an annual fee jumping by more than 50% and $100, a rate moving more than 5 points, or a key field disappearing
- records that fail schema validation
- more than half of an issuer's cards vanishing at once
- a parsed base earn rate moving by more than 1 point per dollar

Cards that disappear from CDR are marked `status = "discontinued"`, not deleted. The first sync that misses a card records `missing_since`; it is discontinued, dated `missing_since`, only if a sync on a later day still misses it, so one bad response from a data holder can't discontinue it. A card the issuer no longer sells but still lists in CDR is marked `status = "closed"` by hand, with a `closed` date when it is known; the sync keeps that status.

## Development

Requires [Bun](https://bun.sh).

```sh
bun install
bun run sync -- --dry-run   # pull CDR data and report changes
bun run sync                # pull CDR data and write data/
bun run validate            # check every file in data/
bun run build               # write the static site and api.json to dist/
bun run test               # Vitest, with Effect test services
bun run lint               # strict, type-aware Oxlint; warnings fail
bun run format             # apply Oxfmt
bun run format:check       # check formatting without writing
bun run check               # everything CI runs; also the pre-commit hook
```

TypeScript enables strict mode and the additional unused-code, return, override, index-access,
optional-property and control-flow checks. Oxlint enables correctness, suspicious, pedantic
and performance rules, including type-aware unsafe-value and promise checks. Generated
`dist/` output is excluded. Both lint and formatting run in `check`, the commit hook and CI.

The complete `@shekohex/oxc-effect` Effect v4 preset is enabled, with every warning
promoted to an error and no Effect rules disabled. It checks composition, tracing,
error handling, Schema boundaries and Effect test services. Effect tests use scoped
`@effect/vitest` layers; Vitest runs under Bun. The Effect plugin uses syntax analysis;
type-aware safety checks come from Oxlint/tsgolint rather than a type-aware Effect plugin.

Vendored [anti-slop](https://github.com/dmmulroy/anti-slop) adds safety, collection,
tagged-value and spacing rules. Authored JS/TS, CSS and HTML code comments are banned;
`bun run lint` runs an independent comment check before Oxlint so lint directives
cannot bypass the ban. Third-party source and required notices remain intact.
See [code policy](docs/code-policy.md) for enabled rules, scoped exceptions and the
vendor update process, and [data model notes](docs/data-model.md) for domain semantics.

The native lint exceptions are intentional: file/function size limits, class counts,
underscore names, import counts, function placement and negated conditions are style
choices; `no-redeclare` incorrectly flags Schema value/type pairs;
`prefer-readonly-parameter-types` rejects library types and deliberately mutable working
models; `no-useless-undefined` conflicts with explicit return checking and required
Effect arguments. One isolated utility reconstructs a conditional mapped type after
removing undefined keys, with its rationale in the code policy. `skipLibCheck` stays
enabled because unpdf declarations reference an optional canvas dependency.

## Hosting

Live at <https://creditcards.matthewstibbard.workers.dev>.

`bun run build` writes a fully static site to `dist/` (`index.html`, hashed JS/CSS and `api.json`). Cloudflare Workers serves `dist/` as static assets, building with `bun run build` from this repo. Every push to `main`, including the daily sync, redeploys it.

## Licence

MIT, for both the code and the data in `data/` and `dist/api.json`. See [LICENSE](LICENSE).

The data is provided as is. Card terms change, so check the issuer's own site before you apply for a card.
