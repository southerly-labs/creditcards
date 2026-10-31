# Vendored anti-slop

Source: https://github.com/dmmulroy/anti-slop
Revision: `13909c9e07590f5a85d93c62712259fe14a883f7` (2026-10-14 UTC).

Production files from upstream `src/` are copied unchanged. Upstream tests and agent
skills are excluded. The root MIT license and nested third-party license/provenance
files are preserved. No agent skill is installed or run.

Keep `@oxlint/plugins` pinned to the exact Oxlint version. To update, stage the new
upstream source separately, compare against this revision, preserve local policy,
and review the new rules before enabling them. This directory is excluded from
project lint and formatting; test local integration through `test/lint-policy.test.ts`.

Enabled rules and exceptions live in `.oxlintrc.json` and `docs/code-policy.md`.
