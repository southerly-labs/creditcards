# Code policy

Oxlint enforces the full Effect v4 preset, additional anti-slop safety rules, and
type-aware TypeScript checks. Oxfmt owns wrapping, indentation, quotes and punctuation.
Anti-slop source and licenses are vendored under `tools/oxlint/anti-slop`; its README
records the reviewed upstream revision and update process.

The first anti-slop rules reject chained assertions, widening followed by assertions,
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
