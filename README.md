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

The sync only owns the fields listed in `CDR_OWNED_PATHS` (`src/sync/merge.ts`). Other fields, such as `rewards.earn`, are never touched by the sync. To stop the sync from overwriting a CDR-derived field you have corrected, add it to `locked`:

```toml
locked = [ "fees.foreign_txn_pct" ]
```

### Sync guardrails

Updates auto-merge. Changes that look wrong are held back and reported in a `sync-held` issue instead:

- the whole run aborts if far fewer cards come back than are active (likely outage)
- an annual fee jumping by more than 50% and $100, a rate moving more than 5 points, or a key field disappearing
- records that fail schema validation
- more than half of an issuer's cards vanishing at once

Cards that disappear from CDR are marked `status = "discontinued"`, not deleted.

## Development

Requires [Bun](https://bun.sh).

```sh
bun install
bun run sync -- --dry-run   # pull CDR data and report changes
bun run sync                # pull CDR data and write data/
bun run validate            # check every file in data/
bun run build               # write dist/api.json
bun test
```
