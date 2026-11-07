import type { Machine } from "@typeonce/effect-machine"
import { Array as EffectArray, Record as EffectRecord, Schema } from "effect"
import { dual } from "effect/Function"

const ActiveNode = Schema.Struct({
  path: Schema.String,
  value: Schema.optionalKey(Schema.Json)
})

export type ActiveNode = typeof ActiveNode.Type

const EncodedSnapshot = Schema.TaggedStruct("MachineSnapshot", {
  version: Schema.Literal(2),
  active: Schema.Array(ActiveNode)
})

export const encodedSnapshot = (active: ReadonlyArray<ActiveNode>): Machine.Machine.EncodedSnapshot =>
  EncodedSnapshot.make({ version: 2, active: [{ path: "" }, ...active] })

type Regions = Readonly<Record<string, { readonly _tag: string }>>

export const regionNodes = dual<
  (regions: Regions) => (root: string) => ReadonlyArray<ActiveNode>,
  (root: string, regions: Regions) => ReadonlyArray<ActiveNode>
>(2, (root: string, regions: Regions): ReadonlyArray<ActiveNode> => [
  { path: root },
  ...EffectArray.flatMap(EffectRecord.toEntries(regions), ([region, value]) => [
    { path: `${root}.${region}` },
    { path: `${root}.${region}.${value._tag}`, value }
  ])
])
