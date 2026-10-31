// Internal invariants must be checked at runtime instead of asserted to TypeScript.
export const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("Internal invariant: expected a value")

  return value
}
