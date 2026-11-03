import {
  Schema,
  SchemaAST,
  Predicate,
  Option,
  Array as EffectArray,
  String as EffectString,
  pipe,
  DateTime
} from "effect"
import { dual } from "effect/Function"

function validUrl(value: string): boolean | string {
  const url = URL.parse(value)

  return (
    (url !== null && ["https:", "http:"].includes(url.protocol) && url.hostname !== "") ||
    "Expected an absolute HTTP(S) URL"
  )
}

export const WebUrl = Schema.String.check(Schema.makeFilter(validUrl))

export const CalendarDate = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      (/^\d{4}-\d{2}-\d{2}$/u.test(value) &&
        Option.isSome(Schema.decodeOption(Schema.DateTimeUtcFromString)(value)) &&
        Option.exists(DateTime.make(value), (date) => DateTime.formatIsoDateUtc(date) === value)) ||
      "Expected a valid YYYY-MM-DD date"
  )
)

export const Timestamp = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      (Schema.is(CalendarDate)(pipe(value, EffectString.slice(0, 10))) &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
        Option.isSome(Schema.decodeOption(Schema.DateTimeUtcFromString)(value))) ||
      "Expected an ISO timestamp with timezone"
  )
)

const recognizesLockImpl = (ast: SchemaAST.AST, path: string): boolean => {
  if (Predicate.isTagged(ast, "Union")) return EffectArray.some(ast.types, (type) => recognizesLock(type, path))

  if (!Predicate.isTagged(ast, "Objects")) return false
  const [head, ...tail] = EffectString.split(path, ".")

  const field = Option.getOrUndefined(
    EffectArray.findFirst(ast.propertySignatures, (property) => property.name === head)
  )

  return field !== undefined && (tail.length === 0 || recognizesLock(field.type, EffectArray.join(tail, ".")))
}

export const recognizesLock: {
  (path: string): (ast: SchemaAST.AST) => boolean
  (ast: SchemaAST.AST, path: string): boolean
} = dual(2, recognizesLockImpl)

type Tier = { readonly category?: string; readonly cap_monthly?: number; readonly cap_annual?: number }

export function orderedTiers(tiers: ReadonlyArray<Tier>): boolean {
  const groups = new Map<string | undefined, Tier[]>()

  for (const tier of tiers) {
    const group = groups.get(tier.category) ?? []
    group.push(tier)
    groups.set(tier.category, group)
  }

  for (const group of groups.values()) {
    for (const period of ["cap_monthly", "cap_annual"] as const) {
      if (!EffectArray.some(group, (tier) => tier[period] !== undefined)) continue

      if (!orderedPeriod(group, period)) return false
    }

    if (
      group.length > 1 &&
      EffectArray.some(
        group,
        (tier, index) => tier.cap_monthly === undefined && tier.cap_annual === undefined && index !== group.length - 1
      )
    )
      return false
  }

  return true
}

function orderedPeriod(group: ReadonlyArray<Tier>, period: "cap_monthly" | "cap_annual"): boolean {
  let previous = -1

  for (const [index, tier] of group.entries()) {
    const cap = tier[period]

    if (cap === undefined) {
      if (index !== group.length - 1) return false
    } else {
      if (cap <= previous) return false
      previous = cap
    }
  }

  return true
}
