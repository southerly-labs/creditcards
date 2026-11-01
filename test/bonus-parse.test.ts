import { describe, expect, test } from "@effect/vitest"
import { BonusResult, bonusTextHash, parseBonus } from "../src/rewards/bonus.ts"
import { applyBonusPlan, BonusPlan, planBonus } from "../src/rewards/plan.ts"

const feature = (additionalValue: string, additionalInfo = "") => ({ additionalValue, additionalInfo })
const parse = (value: string, info?: string) => parseBonus([feature(value, info)])
const reason = (result: BonusResult) => (BonusResult.$is("Review")(result) ? result.reason : undefined)

describe("splits signup bonuses by year", () => {
  test("NAB publishes each year as its own feature", () => {
    expect(
      parseBonus([
        feature(
          "80000",
          "80,000 BONUS POINTS when you spend $3,000 on everyday purchases within 90 days of account opening.Minimum monthly repayments required. NAB may vary or end this offer at any time.Effective from May 27, 2025"
        ),
        feature(
          "20000",
          "20,000 BONUS POINTS when you keep your card for over 12 months. NAB may vary or end this offer at any time."
        )
      ])
    ).toEqual(
      BonusResult.Parsed({
        bonus: [
          { points: 80000, year: 1, min_spend: 3000, spend_days: 90 },
          { points: 20000, year: 2, keep_months: 12 }
        ]
      })
    )
  })

  test("ANZ puts both years in one feature, valued at the total", () => {
    expect(
      parse(
        "100000",
        "Earn 50,000 bonus Qantas Points with your new ANZ Frequent Flyer Black credit card when you spend $6,000 on eligible purchases in the first 3 months from approval. Plus, earn an additional 50,000 bonus Qantas Points when you keep your card for over 12 months. You are not eligible for the initial bonus Qantas Points if you currently hold or have held an ANZ Rewards or ANZ Frequent Flyer credit card in the last 24 months. T&Cs, eligibility criteria, fees and charges apply (including an annual fee, currently $425)."
      )
    ).toEqual(
      BonusResult.Parsed({
        bonus: [
          { points: 50000, year: 1, min_spend: 6000, spend_days: 90 },
          { points: 50000, year: 2, keep_months: 12 }
        ]
      })
    )
  })

  test("Westpac's second year needs spend after the anniversary", () => {
    expect(
      parse(
        "150000",
        "Get up to 150,000 bonus Qantas Points and 50 Status Credits - 90,000 Qantas Points in year 1 and 50 Status Credits if you spend $9k+ on eligible purchases within 90 days of new card approval and an extra 60,000 points with $9k+ spend on eligible purchases within 90 days of card anniversary in year 2. Offer not available if you've held a Westpac credit card in the last 24 months."
      )
    ).toEqual(
      BonusResult.Parsed({
        bonus: [
          { points: 90000, year: 1, min_spend: 9000, spend_days: 90 },
          { points: 60000, year: 2, min_spend: 9000, spend_days: 90 }
        ]
      })
    )
  })

  test("a keep-the-card tranche stays in year 2 despite a payment window", () => {
    expect(
      parse(
        "60000",
        "Earn up to 60,000 CommBank Yello points: Earn 30,000 CommBank Yello points when you spend $4,500 or more on eligible spend with your new Smart credit card within 90 days of activating your card. Earn an additional 30,000 CommBank Yello points when you keep your account open for more than 12 months from card activation and are CommBank Yello eligible at the 12-month anniversary of your card activation as well as at the time the points are paid to your account (which is usually within 31 days from the date that full eligibility requirements are met)."
      )
    ).toEqual(
      BonusResult.Parsed({
        bonus: [
          { points: 30000, year: 1, min_spend: 4500, spend_days: 90 },
          { points: 30000, year: 2, keep_months: 12 }
        ]
      })
    )
  })

  test("a first-year-only offer, ignoring a first-year fee", () => {
    expect(
      parse(
        "30000",
        "Earn 30,000 bonus Qantas Points if you spend $6k+ on eligible purchases within 90 days of new card approval. Already with BankSA? Sign in to apply for a $99 card fee for the first year (reverts to $175 p.a. thereafter)."
      )
    ).toEqual(BonusResult.Parsed({ bonus: [{ points: 30000, year: 1, min_spend: 6000, spend_days: 90 }] }))
  })

  test("the CDR value may be the first tranche rather than the total", () => {
    expect(
      parse(
        "200000",
        "Earn 200,000 NAB Rewards Bonus Points when you spend $8,000 on everyday business purchases within 90 days of your new account opening and a further 50,000 bonus NAB Rewards Bonus Points if you keep your account open for 15 months."
      )
    ).toEqual(
      BonusResult.Parsed({
        bonus: [
          { points: 200000, year: 1, min_spend: 8000, spend_days: 90 },
          { points: 50000, year: 2, keep_months: 15 }
        ]
      })
    )
  })

  test("no bonus features means no bonus", () => {
    expect(parseBonus([])).toEqual(BonusResult.Parsed({ bonus: [] }))
  })
})

describe("sends unclear offers to review", () => {
  test("only an 'up to' total with combined conditions", () => {
    expect(
      reason(
        parse(
          "40000",
          "Earn up to 40,000 Bonus Qantas Points when you spend $4,000 on eligible purchases in the first 4 months and keep your card open for over 15 months."
        )
      )
    ).toBe("only an 'up to' total, no tranches")
  })

  test("tranches that do not add up to the headline", () => {
    expect(
      reason(
        parse(
          "100000",
          "Earn up to 100,000 points. Earn 50,000 points when you spend $3,000 within 90 days. Earn 30,000 points when you keep your card for over 12 months."
        )
      )
    ).toBe("tranches do not add up to the 'up to' total")
  })

  test("points for each month of spend", () => {
    expect(
      reason(
        parse(
          "70000",
          "25,000 Bonus Velocity Points will be awarded for each month $1,500 or more is spent on eligible purchases for the first 60 days from approval. 20,000 Velocity Points will be awarded when you keep your card open for over 12 months."
        )
      )
    ).toBe("points for each month of spend")
  })

  test("offers with end dates", () => {
    expect(
      reason(
        parse(
          "200000",
          "200,000 Qantas Business Rewards bonus points when you open an account and make an eligible purchase before 30 April 2026. The offer applies to new card accounts opened between 31/12/2025- 30/04/2026."
        )
      )
    ).toBe("offer has an end date")
  })

  test("alternative first-year offers", () => {
    expect(
      reason(
        parseBonus([
          feature("80000", "Earn 80,000 points when you spend $2,000 in the first 3 months from approval."),
          feature("85000", "Earn 85,000 points when you spend $3,500 in the first 3 months from approval.")
        ])
      )
    ).toBe("several first-year offers")
  })

  test("cashback rather than points", () => {
    expect(reason(parse("500", "Earn cashback on eligible transactions, up to a maximum of $500 annually."))).toBe(
      "offer includes cashback"
    )
  })

  test("an offer named without details", () => {
    expect(reason(parse("New Card Member Offer"))).toBe("CDR names an offer without its details")
  })

  test("a CDR value that matches nothing in the text", () => {
    expect(reason(parse("90000", "Earn 60,000 bonus points when you spend $3,000 within 90 days of approval."))).toBe(
      "CDR value 90000 matches neither the total nor a tranche"
    )
  })

  test("a tranche with no timing", () => {
    expect(reason(parse("50000", "Earn 50,000 bonus points with your new card."))).toBe(
      "cannot tell when 50000 points are paid"
    )
  })
})

test("the text hash changes with the offer", () => {
  expect(bonusTextHash([feature("80000", "80,000 points")])).not.toBe(
    bonusTextHash([feature("90000", "90,000 points")])
  )
})

describe("plans bonus updates", () => {
  const split = [feature("80000", "80,000 points when you spend $3,000 within 90 days of account opening.")]
  const unclear = [feature("40000", "Earn up to 40,000 points when you keep your card open for over 15 months.")]
  const parsed = [{ points: 80000, year: 1 as const, min_spend: 3000, spend_days: 90 }]
  const empty = { review: undefined, parsed: undefined }
  const fromParser = { review: { state: "present" as const, source: "parser" as const, text_hash: "old" }, parsed }

  test("sets parsed tranches", () => {
    const plan = planBonus(empty, split)
    expect(plan).toEqual(BonusPlan.Set({ bonus: parsed, hash: bonusTextHash(split) }))
    expect(applyBonusPlan(empty, plan)).toEqual({
      review: { state: "present", source: "parser", text_hash: bonusTextHash(split) },
      parsed
    })
  })

  test("leaves parsed tranches alone when the text is unchanged", () => {
    const current = { ...fromParser, review: { ...fromParser.review, text_hash: bonusTextHash(split) } }
    expect(planBonus(current, split)).toEqual(BonusPlan.Unchanged())
  })

  test("clears a stale parsed bonus the parser can no longer read", () => {
    const plan = planBonus(fromParser, unclear)
    expect(plan).toEqual(BonusPlan.Review({ reason: "only an 'up to' total, no tranches", clear: true }))
    expect(applyBonusPlan(fromParser, plan)).toEqual({ review: { state: "unknown" }, parsed: undefined })
  })

  test("keeps a manual bonus but asks for review when the text changes", () => {
    const current = {
      review: { state: "present" as const, source: "manual" as const, text_hash: "old" },
      parsed: undefined
    }

    expect(planBonus(current, unclear)).toEqual(
      BonusPlan.Review({ reason: "bonus text changed since manual review", clear: false })
    )
    expect(
      planBonus({ ...current, review: { ...current.review, text_hash: bonusTextHash(unclear) } }, unclear)
    ).toEqual(BonusPlan.Unchanged())
  })

  test("removes a parsed bonus when the offer ends", () => {
    expect(planBonus(fromParser, [])).toEqual(BonusPlan.Clear())
  })
})
