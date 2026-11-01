import type { BonusTranche, Card, IntroOffer } from "../model/schema"
import type { Offer, SignupReview } from "./schema"

const introIds = { purchase: "intro-purchase", balance_transfer: "intro-balance-transfer", both: "intro-both" } as const

export const cdrOffers = (input: {
  readonly intro?: ReadonlyArray<IntroOffer> | undefined
  readonly annualFirstYear?: number | undefined
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
  readonly source?: "parser" | "manual"
  readonly rawTotal: number | undefined
  readonly review: Pick<SignupReview, "state"> | undefined
}): Offer | undefined => {
  if (input.review?.state === "none") return undefined
  const [first, ...rest] = input.tranches ?? []

  if (first !== undefined) {
    return {
      id: "signup",
      source: input.source ?? "parser",
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

type Rewards = NonNullable<Card["rewards"]>

const manualBonusState = (rewards: Rewards) => ((rewards.bonus?.length ?? 0) === 0 ? "none" : "present")

export const legacySignupReview = (rewards: Rewards | undefined): SignupReview | undefined => {
  if (rewards === undefined) return undefined
  const { bonus_source: source, bonus_review: review, bonus_text_hash: hash } = rewards

  const fallback = source === "manual" ? manualBonusState(rewards) : undefined
  const state = review?.state ?? (source === "parser" ? "present" : fallback)

  if (state === undefined) return undefined

  return {
    state,
    ...(source === undefined ? {} : { source }),
    ...(hash === undefined ? {} : { text_hash: hash }),
    ...(review?.reviewed_at === undefined ? {} : { reviewed_at: review.reviewed_at })
  }
}

export const withOffers = (card: Card): Card => {
  const { offers: stored, signup_review: _review, ...rest } = card
  const rewards = card.rewards
  const review = legacySignupReview(rewards)
  const locked = (card.locked ?? []).includes("offers")
  const manualBonus = rewards?.bonus_source === "manual"

  const signup =
    rewards === undefined
      ? undefined
      : signupOffer({
          program: rewards.program,
          tranches: rewards.bonus,
          source: manualBonus ? "manual" : "parser",
          rawTotal: rewards.bonus_points,
          review
        })

  const offers = combineOffers({
    existing: locked || !manualBonus ? stored : stored?.filter((offer) => offer.id !== "signup"),
    generated: [
      ...cdrOffers({ intro: card.rates.intro, annualFirstYear: card.fees.annual_first_year }),
      ...(signup === undefined ? [] : [signup])
    ],
    locked
  })

  return {
    ...rest,
    ...(offers.length === 0 ? {} : { offers }),
    ...(review === undefined ? {} : { signup_review: review })
  }
}
