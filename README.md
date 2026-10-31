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
```

The schema lives in `src/model/schema.ts`. Percentages are stored as percent (`20.99`) and money in AUD.

### Editing data by hand

The CDR sync only owns the fields listed in `CDR_OWNED_PATHS` (`src/sync/merge.ts`); earn rates are handled separately (see below). To stop the sync from overwriting a CDR-derived field you have corrected, add it to `locked`:

```toml
locked = [ "fees.foreign_txn_pct" ]
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

No LLM runs in CI and no API key is needed.

### Sync guardrails

Updates auto-merge. Changes that look wrong are held back and reported in a `sync-held` issue instead:

- the whole run aborts if far fewer cards come back than are active (likely outage)
- an annual fee jumping by more than 50% and $100, a rate moving more than 5 points, or a key field disappearing
- records that fail schema validation
- more than half of an issuer's cards vanishing at once
- a parsed base earn rate moving by more than 1 point per dollar

Cards that disappear from CDR are marked `status = "discontinued"`, not deleted.

## Development

Requires [Bun](https://bun.sh).

```sh
bun install
bun run sync -- --dry-run   # pull CDR data and report changes
bun run sync                # pull CDR data and write data/
bun run validate            # check every file in data/
bun run build               # write the static site and api.json to dist/
bun test
bun run check               # everything CI runs; also the pre-commit hook
```

## Hosting

Live at <https://creditcards.matthewstibbard.workers.dev>.

`bun run build` writes a fully static site to `dist/` (`index.html`, hashed JS/CSS and `api.json`). Cloudflare Workers serves `dist/` as static assets, building with `bun run build` from this repo. Every push to `main`, including the daily sync, redeploys it.

## Licence

MIT, for both the code and the data in `data/` and `dist/api.json`. See [LICENSE](LICENSE).

The data is provided as is. Card terms change, so check the issuer's own site before you apply for a card.
