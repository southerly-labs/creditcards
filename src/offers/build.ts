import type { BonusTranche, Card, IntroOffer } from "../model/schema"
import type { SignupState } from "../rewards/plan"
import type { Offer, OfferComponent } from "./schema"
import { reviewedNone } from "../machine/review.ts"
import { signupStateOf } from "../rewards/state.ts"
import { Array as EffectArray, Option, pipe } from "effect"
import { dual } from "effect/Function"

export interface CdrOfferInputs {
  readonly intro?: ReadonlyArray<IntroOffer> | undefined
  readonly annualFirstYear?: number | undefined
  readonly bonusPoints?: number | undefined
}

const introIds = { purchase: "intro-purchase", balance_transfer: "intro-balance-transfer", both: "intro-both" } as const

export const cdrOffers = (input: CdrOfferInputs): Array<Offer> => {
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
  readonly noOffer: boolean
}): Offer | undefined => {
  if (input.noOffer) return undefined
  const [first, ...rest] = input.tranches ?? []

  if (first !== undefined) {
    return {
      id: "signup",
      source: "parser",
      components: [
        { kind: "signup_points", program: input.program, ...first },
        ...EffectArray.map(rest, (tranche) =>
          Object.assign({ kind: "signup_points" as const, program: input.program }, tranche)
        )
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
  const manual = EffectArray.filter(existing, (offer) => offer.source === "manual")
  const manualById = new Map(EffectArray.map(manual, (offer) => [offer.id, offer] as const))
  const offers: Array<Offer> = []

  for (const offer of input.generated) offers.push(manualById.get(offer.id) ?? offer)

  return [...offers, ...EffectArray.filter(manual, (offer) => !offers.includes(offer))]
}

const parsedTranche = (component: OfferComponent): ReadonlyArray<BonusTranche> => {
  if (component.kind !== "signup_points" || component.year === undefined) return []
  const { kind: _kind, program: _program, year, ...rest } = component

  return [{ ...rest, year }]
}

export const signupState = (card: Card | undefined): SignupState => ({
  state: signupStateOf(card),
  parsed: pipe(
    EffectArray.findFirst(card?.offers ?? [], (offer) => offer.id === "signup" && offer.source === "parser"),
    Option.map((offer) => EffectArray.flatMap(offer.components, (component) => parsedTranche(component))),
    Option.getOrUndefined
  )
})

const applyOffersImpl = (card: Card, cdr: CdrOfferInputs, signup: SignupState): Card => {
  const { offers: stored, ...rest } = card

  const offer =
    card.rewards === undefined
      ? undefined
      : signupOffer({
          program: card.rewards.program,
          tranches: signup.parsed,
          rawTotal: cdr.bonusPoints,
          noOffer: reviewedNone(signup.state)
        })

  const offers = combineOffers({
    existing: stored,
    generated: [...cdrOffers(cdr), ...(offer === undefined ? [] : [offer])],
    locked: (card.locked ?? []).includes("offers")
  })

  return { ...rest, ...(offers.length === 0 ? {} : { offers }) }
}

export const applyOffers = dual<
  (cdr: CdrOfferInputs, signup: SignupState) => (card: Card) => Card,
  (card: Card, cdr: CdrOfferInputs, signup: SignupState) => Card
>(3, applyOffersImpl)
