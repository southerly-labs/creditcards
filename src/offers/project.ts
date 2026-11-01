import type { Offer } from "./schema"

export const offerStatus = (offer: Offer, today: string): "upcoming" | "expired" | "undated" | "within_window" => {
  if (offer.valid_from !== undefined && today < offer.valid_from) return "upcoming"

  if (offer.valid_until !== undefined && today > offer.valid_until) return "expired"

  if (offer.valid_from === undefined && offer.valid_until === undefined) return "undated"

  return "within_window"
}
