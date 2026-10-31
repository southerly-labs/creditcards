# Code policy

Oxlint enforces the full Effect v4 preset, additional anti-slop safety rules, and
type-aware TypeScript checks. Oxfmt owns wrapping, indentation, quotes and punctuation.
Anti-slop source and licenses are vendored under `tools/oxlint/anti-slop`; its README
records the reviewed upstream revision and update process.

The anti-slop safety rules reject chained assertions, widening followed by assertions,
Reflect indirection, module mocking, accumulator copies, opaque object parameters,
unknown type aliases, and locally owned names containing `shape`. Native Oxlint also
rejects accumulating spreads. These rules complement the existing Effect preset.

Boundary parsers and dynamic merge utilities legitimately operate on unknown values.
The anti-slop rules banning unknown parameters/returns, unknown dictionaries, runtime
`typeof`, and all known-value widening are not enabled. Conditional object spreads
remain allowed because absent optional fields must stay absent. The service-constructor
import rule mistakes the pure `makeProgramIndex` lookup builder for a service and is
not enabled. Other native lint exceptions are documented in the root README.

## Optional-field type invariant

`src/util/defined.ts` removes exactly the enumerable keys whose values are undefined,
leaving all other keys and values intact. Its conditional mapped result type expresses
that contract. TypeScript cannot infer the relationship from `Record.filter`, so the
single assertion lives in this single-purpose utility. Only this file is exempt from
`typescript/no-unsafe-type-assertion` and anti-slop's assertion-comment requirement;
the implementation and rationale are reviewed together here. The assertion-comment
rule remains enabled elsewhere. All `as const` assertions remain valid.

## Effect and collection policy

The parser and rewards planner use `Data.taggedEnum` constructors and refinements.
Effect results use `Result.isFailure` rather than direct `_tag` comparisons.
Anti-slop's manual-error-tag, manual-tag-comparison, manual-tag-construction and
repeated-ternary rules are errors. The service-constructor rule remains excluded
for the pure lookup-builder reason above.

Adjacent eager filter/map passes use lazy iterators where callbacks are pure and
runtime support is guaranteed by Bun. Browser code retains supported collection
operations. Anti-slop owns blank-line spacing; Oxfmt owns all other formatting.

## Comment policy

Authored JavaScript, TypeScript, JSX, TSX, CSS and HTML must contain no code comments.
Use descriptive names and documentation, including [data-model.md](data-model.md),
for invariants and domain explanations. The project Oxlint rule rejects JavaScript
and TypeScript comments in the editor and CLI. `bun run comments:check` also runs
before Oxlint in `bun run lint`, so a disabling comment cannot suppress its own
violation. The independent check parses JavaScript/TypeScript with Oxc, parses HTML
with Bun's HTMLRewriter, and distinguishes CSS comments from strings and URL tokens.

The check covers `src/`, `web/`, `test/`, `tools/`, and root source files. Vendored
anti-slop source and its required notices are preserved and excluded; generated
`dist/` and dependencies are not authored source. Documentation and configuration
comments are outside this source policy. Interpreter shebangs remain valid. Tokens
inside strings, regexes, templates and HTML attributes are data rather than comments.

An uncommented non-const assertion violates anti-slop's safety-comment rule, and a
safety comment violates the comment ban. This deliberately makes non-const
assertions unavailable outside the documented `defined.ts` invariant exception.
