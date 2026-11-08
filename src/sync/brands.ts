import type { Card } from "../model/schema.ts"

const byName = (name: string) => `name:${name}`

export const cardBrand = (cdr: NonNullable<Card["cdr"]>): string => cdr.brand_id ?? byName(cdr.brand)

export const fetchedBrands = (brand: {
  readonly name: string
  readonly id: string | undefined
}): ReadonlyArray<string> => (brand.id === undefined ? [byName(brand.name)] : [brand.id, byName(brand.name)])
