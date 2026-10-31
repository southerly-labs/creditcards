// Friendly slugs and names for CDR brands, used only when an issuer is first
// created. After that, data/issuers/<slug>/issuer.toml is the source of truth.
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
  s
    .normalize("NFKD")
    .replace(/[®™©]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")

const CORPORATE_SUFFIX = /\b(limited|ltd|pty|australia|bank of australia)\b/gi

export const issuerSeed = (brandName: string) =>
  ISSUER_SEEDS[brandName] ?? {
    slug: slugify(brandName.replace(CORPORATE_SUFFIX, "")),
    name: brandName.replace(/\s+(Limited|Ltd\.?)$/i, "").trim()
  }

// Card slug from the product name, without the issuer's own name.
export const cardSlug = (cardName: string, issuerName: string) => {
  const issuerWords = new Set(slugify(issuerName).split("-"))
  const words = slugify(cardName).split("-")
  let start = 0
  while (start < words.length - 1 && (issuerWords.has(words[start]!) || words[start] === "the")) start++
  return words.slice(start).join("-") || slugify(cardName)
}
