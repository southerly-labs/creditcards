export const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("Internal invariant: expected a value")

  return value
}
