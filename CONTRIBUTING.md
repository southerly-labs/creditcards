# Contributing

Thanks for helping. The most useful contribution is telling us when the data is wrong.

## Pull requests are turned off

This repo is trunk-based: maintainers and the daily sync bot commit straight to `main` (see [AGENTS.md](AGENTS.md)). We don't accept pull requests, so please open an issue instead. A good issue is often quicker for us to act on than a patch.

## Reporting wrong or missing data

Use the **Data correction** issue template. Include:

- the card (its name, or the path under `data/issuers/`)
- which field is wrong, and the correct value
- a link to the issuer's page or PDF that shows it

Most fees and rates come from the issuer's own Consumer Data Right (CDR) feed. If that feed is wrong, the sync will keep putting the wrong value back, so we lock the field in the card's TOML file. It also helps to tell the issuer.

Earn rates, point values and loyalty programs are curated by hand, so corrections to those are especially welcome.

## Bugs and ideas

Use the **Bug report** template for problems with the website, `api.json` or the CLI, and the **Idea** template for anything else.

## Running it locally

You'll need [Bun](https://bun.sh). See [Development](README.md#development) in the README. `bun run check` runs everything CI does.

## Licence

By opening an issue with a correction or suggestion, you agree that we can use it in the project under its [MIT licence](LICENSE).
