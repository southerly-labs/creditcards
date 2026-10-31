import { Record as EffectRecord } from "effect"

type Defined<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>
}

export const defined = <T extends Record<string, unknown>>(obj: T): Defined<T> =>
  EffectRecord.filter(obj, (value) => value !== undefined) as Defined<T>
