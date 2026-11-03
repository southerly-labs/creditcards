import type { Dataset } from "../store/Store.ts"
import { DateTime, Option } from "effect"

export const datasetFreshness = (dataset: Dataset) => {
  const timestamps: Array<number> = []

  for (const card of dataset.cards.values()) {
    const value = card.cdr?.last_updated

    if (value !== undefined && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
      const time = DateTime.make(value)

      if (Option.isSome(time)) timestamps.push(DateTime.toEpochMillis(time.value))
    }
  }

  return {
    ...(timestamps.length > 0
      ? { cdr_latest_product_updated_at: DateTime.formatIso(DateTime.makeUnsafe(Math.max(...timestamps))) }
      : {}),
    cdr_products_with_known_updated_at: timestamps.length,
    card_count: dataset.cards.size
  }
}
