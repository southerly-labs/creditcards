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
