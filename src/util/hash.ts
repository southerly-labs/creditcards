import { Effect, String as EffectString } from "effect"
import { Digest } from "effect/crypto"

export const sha256Prefix = Effect.fn("sha256Prefix")(function* (text: string, length: number) {
  const digest = yield* Digest.Digest
  const hex = yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(text))

  return EffectString.slice(0, length)(hex)
})
