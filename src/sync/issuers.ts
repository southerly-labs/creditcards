import { required } from "../util/required.ts"
import { Array as EffectArray, String as EffectString, pipe } from "effect"
import { dual } from "effect/Function"

export const ISSUER_SEEDS: Record<string, { readonly slug: string; readonly name: string }> = {
  "American Express": { slug: "amex", name: "American Express" },
  ANZ: { slug: "anz", name: "ANZ" },
  "Bank of Melbourne": { slug: "bank-of-melbourne", name: "Bank of Melbourne" },
  "Bank of Queensland Limited": { slug: "boq", name: "Bank of Queensland" },
  BankSA: { slug: "banksa", name: "BankSA" },
  "Coles Credit Cards": { slug: "coles", name: "Coles" },
  CommBank: { slug: "commbank", name: "CommBank" },
  "ING BANK (Australia) Ltd": { slug: "ing", name: "ING" },
  "Kogan Money Credit Cards": { slug: "kogan-money", name: "Kogan Money" },
  "Latitude Credit Cards": { slug: "latitude", name: "Latitude" },
  "Macquarie Bank Limited": { slug: "macquarie", name: "Macquarie" },
  "NATIONAL AUSTRALIA BANK": { slug: "nab", name: "NAB" },
  "Qantas Money Credit Cards": { slug: "qantas-money", name: "Qantas Money" },
  "St.George Bank": { slug: "st-george", name: "St.George" },
  Westpac: { slug: "westpac", name: "Westpac" }
}

export const slugify = (s: string) =>
  pipe(
    s,
    EffectString.normalize("NFKD"),
    EffectString.replaceAll(/[®™©]/gu, ""),
    EffectString.toLowerCase,
    EffectString.replaceAll("&", " and "),
    EffectString.replaceAll(/[^a-z0-9]+/gu, "-"),
    EffectString.replaceAll(/^-|-$/gu, "")
  )

const CORPORATE_TAIL = /(?:\s+\(?australia\)?)?(?:\s+(?:limited|ltd|pty)\.?)+$/iu

export const issuerSeed = (brandName: string) =>
  ISSUER_SEEDS[brandName] ?? {
    slug: slugify(pipe(brandName, EffectString.replace(CORPORATE_TAIL, ""))),
    name: EffectString.trim(pipe(brandName, EffectString.replace(/\s+(Limited|Ltd\.?)$/iu, "")))
  }

const cardSlugImpl = (cardName: string, issuerName: string): string => {
  const issuerWords = new Set(EffectString.split(slugify(issuerName), "-"))
  const words = EffectString.split(slugify(cardName), "-")
  let start = 0

  while (start < words.length - 1 && (issuerWords.has(required(words[start])) || words[start] === "the")) start++

  return EffectArray.join(words.slice(start), "-") || slugify(cardName)
}

export const cardSlug = dual<
  (issuerName: string) => (cardName: string) => string,
  (cardName: string, issuerName: string) => string
>(2, cardSlugImpl)
