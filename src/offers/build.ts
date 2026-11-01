import type { BonusTranche, IntroOffer } from "../model/schema"
import type { Offer } from "./schema"

type SignupReview = { readonly state: "unknown" | "present" | "none" }

const introIds = { purchase: "intro-purchase", balance_transfer: "intro-balance-transfer", both: "intro-both" } as const

export const cdrOffers = (input: {
  readonly intro?: ReadonlyArray<IntroOffer>
  readonly annualFirstYear?: number
}): Array<Offer> => {
  const used = new Map<string, number>()
  const offers: Array<Offer> = []

  for (const intro of input.intro ?? []) {
    const base = introIds[intro.applies_to]
    const count = (used.get(base) ?? 0) + 1
    used.set(base, count)
    offers.push({
      id: count === 1 ? base : `${base}-${count}`,
      source: "cdr",
      components: [{ kind: "intro_rate", ...intro }]
    })
  }

  if (input.annualFirstYear !== undefined) {
    offers.push({
      id: "first-year-fee",
      source: "cdr",
      components: [{ kind: "fee_discount", fee: "annual", payable: input.annualFirstYear, months: 12 }]
    })
  }

  return offers
}

export const signupOffer = (input: {
  readonly program: string
  readonly tranches: ReadonlyArray<BonusTranche> | undefined
  readonly rawTotal: number | undefined
  readonly review: SignupReview | undefined
}): Offer | undefined => {
  if (input.review?.state === "none") return undefined
  const [first, ...rest] = input.tranches ?? []

  if (first !== undefined) {
    return {
      id: "signup",
      source: "parser",
      components: [
        { kind: "signup_points", program: input.program, ...first },
        ...rest.map((tranche) => Object.assign({ kind: "signup_points" as const, program: input.program }, tranche))
      ]
    }
  }

  if (input.rawTotal === undefined || input.rawTotal <= 0) return undefined

  return {
    id: "signup",
    source: "cdr",
    components: [{ kind: "signup_points", program: input.program, points: input.rawTotal }]
  }
}

export const combineOffers = (input: {
  readonly existing: ReadonlyArray<Offer> | undefined
  readonly generated: ReadonlyArray<Offer>
  readonly locked: boolean
}): ReadonlyArray<Offer> => {
  const existing = input.existing ?? []

  if (input.locked) return existing
  const manual = existing.filter((offer) => offer.source === undefined || offer.source === "manual")
  const manualById = new Map(manual.flatMap((offer) => (offer.id === undefined ? [] : [[offer.id, offer] as const])))
  const offers: Array<Offer> = []

  for (const offer of input.generated)
    offers.push((offer.id === undefined ? undefined : manualById.get(offer.id)) ?? offer)

  return [...offers, ...manual.filter((offer) => !offers.includes(offer))]
}
