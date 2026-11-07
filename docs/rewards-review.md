# Rewards section review states

Each card with a rewards program records two review states, `earn_state` for the
CDR loyalty text behind `rewards.earn` and `signup_state` for the CDR
`BONUS_REWARDS` text behind the signup offer. Both are driven by one statechart,
`src/machine/review.ts`, and stored as a table with a `_tag`:

- `Unread`: nothing has been read from the text yet, or the bonus text names no
  offer. A missing state means `Unread`.
- `Parsed` (`hash`): the parser read the text with that hash and wrote the rates
  or tranches.
- `Unreadable` (`hash`): the parser could not read the text with that hash. Earn
  rates keep their previous values; a parsed bonus is removed. Needs a reviewer.
- `Reviewed` (`hash`, `outcome`, optional `on`): a person stamped the section
  against the text with that hash. `outcome` is `present` (a nonempty earn array
  or a signup offer) or `none` (no fixed earn rate, or no current points signup
  offer; it does not assert the absence of cashback or other benefits). `on` is
  the UTC date of stamping; it is never inferred, so older reviews have none.
- `Stale` (same fields): the text has changed since that review. Needs a
  reviewer. If the text changes back, it returns to `Reviewed`.

Each sync sends the machine a `Read` (the text's hash and whether the parser read
it, found nothing or could not read it). `bun run cli rewards stamp`,
`rewards bonus-stamp` and the `/earn-none` and `/bonus-none` comment commands send
`Stamp`, from any state. Reviewed and stale sections are never overwritten by the
parser. Failed issuer-page quote checks still request review independently.

`api.json` keeps publishing the older fields, derived from these states:
`rewards.earn_source` (`parser` for Parsed and Unreadable, `manual` for Reviewed
and Stale), `rewards.earn_text_hash`, `rewards.earn_review` (`state` of `present`,
`none` or `unknown`, and `reviewed_at`) and `signup_review` (`state`, `source`,
`text_hash`, `reviewed_at`). A missing object still means unknown, never reviewed
absence.
