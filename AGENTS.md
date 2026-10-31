# creditcards

See README.md for what this is, the data layout and the sync guardrails.

## How changes land: trunk-based, push to main

There are no feature branches or PRs in this repo. Every change is a small commit pushed straight to `main`. The daily sync bot already works this way, and so do people and agents.

### Before every push

CI (`.github/workflows/ci.yml`) runs only after the push lands, so the local check is what keeps `main` working. The pre-commit hook in `.githooks/` runs `bun run check` (typecheck, tests, validate and build, about 1 second). `bun install` turns the hook on; to turn it on by hand, run `git config core.hooksPath .githooks`. Don't skip it with `--no-verify`. If your tool doesn't run git hooks, run `bun run check` yourself before you commit.

Then rebase onto the remote and push:

```sh
git pull --rebase origin main && git push origin HEAD:main
```

The sync bot commits to `data/` every day at 20:00 UTC, so always rebase before you push. Never force-push `main`.

### Keep commits small and shippable

- Each commit must pass the checks above on its own and leave the site and `dist/api.json` working. Unused code is fine; broken code is not.
- If a change seems to need a branch, split it into steps. Push each step on its own (see the patterns below).
- Aim for commits that take minutes to review in `git log -p`. If a commit mixes a refactor with a behaviour change, split it into two commits.
- Keep hand edits to `data/` in separate commits from code changes, so either one can be reverted cleanly.

### If main breaks

Fixing `main` comes before any other work. Fix it forward if the fix is obvious. Otherwise `git revert` the bad commit and push the revert, then find the cause.

## Patterns for splitting changes

### Schema changes (`src/model/schema.ts`, `data/**/*.toml`)

Use expand, migrate, contract. Each step is its own commit, and each one passes `validate`.

1. **Expand.** Add the new field as optional, or accept both the old and new shape. Validation passes against the current data.
2. **Migrate.** Update the sync and normalisers (`src/sync`, `src/cdr`) to write the new shape. Migrate existing files with a one-off script, or let the next sync run rewrite them. Large migrations can go one issuer at a time.
3. **Contract.** Once every file uses the new shape, make the field required or remove the old one.

To rename a field: add the new name, write both names, move readers over to the new one, then delete the old name.

### Sync ownership (`CDR_OWNED_PATHS` in `src/sync/merge.ts`)

When the sync starts owning a field, it overwrites hand edits on its next run. Before you add a path:

1. Run `bun run sync -- --dry-run` and read the diff it reports.
2. Add `locked` entries to any cards whose hand-corrected values need to survive.
3. Then push the ownership change.

Changes that loosen the guardrails get their own commit, with the reason in the commit message.

### API output (`dist/api.json`, `src/build`) and the web app (`web/`)

Additive changes only. Add the new field and update `web/` to use it, then remove the old field in a later commit. Don't change what an existing key means; add a new key instead.

### New data sources (scraping or LLM extraction for rewards and earn rates)

Bring a new source in at its own pace, in this order:

1. Ship the fetcher and parser with tests, without connecting them to anything yet.
2. Run them in report-only mode, like `--dry-run`: they log what they would change and write nothing.
3. Let them write fields the CDR sync doesn't own, with guardrails that hold suspicious changes in the `sync-held` issue. They never get silent overwrites.
4. Widen coverage one issuer at a time.

### Large refactors

Add the new module next to the old one and move callers over a few at a time, one commit per step. Delete the old code in the final commit. Never leave a gap where neither the old code nor the new code works.

## Dependencies

Every dependency is pinned to an exact version, and nothing published less than 72 hours ago gets installed.

- **npm packages.** `bunfig.toml` sets `exact = true` and `minimumReleaseAge = 259200` (72 hours), so `bun add` saves exact versions and won't pick anything newer than 72 hours. Never write `^` or `~` ranges in `package.json`, and don't weaken or bypass these settings. If you need a version that is too new, wait until it's old enough.
- **Bun.** The version is in `packageManager` in `package.json`. CI reads it from there. Cloudflare's build reads `BUN_VERSION`, which is set in the dashboard, so keep the two in sync.
- **GitHub Actions.** Pin each action to a full commit SHA, with the version in a comment, for example `actions/checkout@<sha> # v4.4.0`. Check that the release is more than 72 hours old.
- **Upgrades.** Do them on purpose, one dependency per commit, and check the publish date (`npm view <pkg> time`) first. `tsrs` is a beta, so read its changelog before you upgrade it.

## Deploys

`wrangler.jsonc` configures the Cloudflare Worker that serves `dist/` as a static site. Cloudflare builds and deploys every push to `main`. Files in `dist/assets/` have content-hashed names and are cached for a year (`dist/_headers`, written by `web/build.ts`). Anything a page loads should go through the bundler, so it gets a hashed name in `assets/`. Never give an unhashed file long-term caching.

Cloudflare's build settings live in the dashboard, not the repo: there's no build command (wrangler runs `bun run build` itself), the deploy command is `bunx wrangler deploy`, and the build variable `BUN_VERSION` must match `packageManager`. To inspect or change them, or to read build logs, use the `cf` CLI (`cf builds ...`) with `CLOUDFLARE_ACCOUNT_ID=59be782473bda4cbd48bbae56df8ce68`. The Worker is `creditcards`.

## Working as an agent here

- Agents do the bookkeeping that used to make trunk-based work tedious: splitting work into steps, temporary dual-shape support and step-by-step migrations. Plan multi-step work as a numbered list of pushable commits before you start, then push each one as soon as it passes the checks.
- Don't hold changes back to land them in one big batch at the end. If you stop partway through a plan, everything already on `main` must work.
- Commit as `southerly-stibbs`. The local git config already sets this.
