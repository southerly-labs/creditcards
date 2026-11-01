import type { Card } from "../model/schema"
import type { Offer } from "./schema"

export const offerStatus = (offer: Offer, today: string): "upcoming" | "expired" | "undated" | "within_window" => {
  if (offer.valid_from !== undefined && today < offer.valid_from) return "upcoming"

  if (offer.valid_until !== undefined && today > offer.valid_until) return "expired"

  if (offer.valid_from === undefined && offer.valid_until === undefined) return "undated"

  return "within_window"
}

export const projectOffers = (card: Card): ReadonlyArray<Offer> => {
  if (card.offers !== undefined) return card.offers

  const offers: Array<Offer> = (card.rates.intro ?? []).map((intro) => ({
    components: [{ kind: "intro_rate", ...intro }]
  }))

  if (card.fees.annual_first_year !== undefined) {
    offers.push({
      components: [{ kind: "fee_discount", fee: "annual", payable: card.fees.annual_first_year, months: 12 }]
    })
  }

  const rewards = card.rewards

  if (rewards?.bonus !== undefined && rewards.bonus.length > 0) {
    const [first, ...rest] = rewards.bonus

    if (first) {
      offers.push({
        components: [
          { kind: "signup_points", program: rewards.program, ...first },
          ...rest.map((tranche) => Object.assign({ kind: "signup_points" as const, program: rewards.program }, tranche))
        ]
      })
    }
  }

  return offers
}

export const availableOffers = (card: Card, today: string): ReadonlyArray<Offer> =>
  projectOffers(card).filter((offer) => ["within_window", "undated"].includes(offerStatus(offer, today)))
