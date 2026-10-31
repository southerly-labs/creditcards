import { describe, expect, test } from "@effect/vitest"
import { loyaltyTextHash, ParseResult, parseEarn } from "../src/rewards/parse.ts"
import { planRewards, RewardsPlan } from "../src/rewards/plan.ts"

const feature = (additionalValue: string, additionalInfo = "") => ({ additionalValue, additionalInfo })
const parse = (value: string, info?: string) => parseEarn([feature(value, info)])

describe("parses simple earn rates", () => {
  test("single rate", () => {
    expect(parse("Bendigo Bank Rewards", "Earn 1.5 Bendigo Bank Rewards points for every dollar spent")).toEqual(
      ParseResult.Parsed({ earn: [{ rate: 1.5 }] })
    )
  })

  test("rate per $2", () => {
    expect(parse("Earn Qantas Frequent Flyer Points - Earn 1 Qantas point for every $2 you spend")).toEqual(
      ParseResult.Parsed({ earn: [{ rate: 0.5 }] })
    )
  })

  test("rate per $1.50 with a spend cap", () => {
    expect(
      parse(
        "Qantas Business Rewards",
        "Earn points on everyday business purchases Earn 1 Qantas Point for every AU$1.50 you spend on everyday business purchases. Qantas Points are earned at the business level. Qantas Points are capped at $50,000 per card per statement period."
      )
    ).toEqual(ParseResult.Parsed({ earn: [{ rate: 0.6667, cap_monthly: 50000 }] }))
  })

  test("ANZ-style tiers with a hard ceiling", () => {
    expect(
      parse(
        "Qantas Points",
        "Qantas Points you will earn on eligible purchases: • 1 Qantas Point per $1 spent on eligible purchases up to and including $7,500 per statement period. • 0.5 Qantas Points per $1 spent on eligible purchases over $7,500 up to and including $50,000 per statement period. • No Qantas Points earned over $50,000 per statement period."
      )
    ).toEqual(
      ParseResult.Parsed({
        earn: [
          { rate: 1, cap_monthly: 7500 },
          { rate: 0.5, cap_monthly: 50000 }
        ]
      })
    )
  })

  test("Bankwest-style 'first $X ... thereafter'", () => {
    expect(
      parse(
        "Qantas Rewards",
        "Earn uncapped Qantas Points. Earn 1 Qantas Point per $1 on the first $3,000 spent on eligible purchases per month, and 0.2 points thereafter."
      )
    ).toEqual(ParseResult.Parsed({ earn: [{ rate: 1, cap_monthly: 3000 }, { rate: 0.2 }] }))
  })

  test("Macquarie-style 'up to ... then ... over'", () => {
    expect(
      parse(
        "Macquarie Rewards",
        "Earn 2 Macquarie Reward Points per $1 spent on eligible purchases up to and including $10,000, then earn 0.5 Macquarie Reward points for every $1 spent on eligible purchases over $10,000 in any given statement period."
      )
    ).toEqual(ParseResult.Parsed({ earn: [{ rate: 2, cap_monthly: 10000 }, { rate: 0.5 }] }))
  })
})

describe("leaves anything complex for review", () => {
  const cases: Array<[string, string, string]> = [
    [
      "category rates",
      "Membership Rewards",
      "3 points per $1 spent at major supermarkets and major petrol stations in Australia. 2 points per $1 spent on spend in a foreign currency overseas and online. 1 point per $1 spent everywhere else in Australia."
    ],
    [
      "government exclusions",
      "Membership Rewards",
      "1.5 points per $1 spent on all purchases, excluding government bodies."
    ],
    [
      "'up to N points'",
      "CommBank Yello Program",
      "Earn unlimited points with your Ultimate credit card if you're eligible for CommBank Yello, with up to 6.5 points per $1 spent on eligible purchases."
    ],
    ["cashback", "Cash back", "Earn 1% cashback on your eligible spend, up to $30 a month."],
    [
      "points cap",
      "Free Qantas Frequent Flyer Membership",
      "Earn 0.6 Qantas Points per dollar spent, capped at 20,000 per statement period."
    ],
    ["no numbers", "Flybuys", ""],
    [
      "choice of programs",
      "Frequent Flyer Rewards",
      "1 Qantas Point or 1 Velocity Frequent Flyer Point for every $1 spent on eligible purchases in Australia up to $7,500"
    ]
  ]

  for (const [name, value, info] of cases) {
    test(name, () => {
      expect(parse(value, info)._tag).toBe("Review")
    })
  }

  test("several loyalty features with different categories", () => {
    expect(
      parseEarn([
        feature(
          "Amplify Rewards Points",
          "1.25 Amplify points per $1 on everyday spend. Once you spend $5,000 in a statement cycle, you will earn 0.5 Amplify Points per $1 on further eligible purchases."
        ),
        feature(
          "Amplify Rewards Points",
          "2 Amplify points per $1 on international spend. Once you spend $5,000 in a statement cycle, you will earn 0.5 Amplify Points per $1 on further eligible purchases."
        )
      ])._tag
    ).toBe("Review")
  })
})

test("text hash is stable and whitespace-insensitive", () => {
  expect(loyaltyTextHash([feature("Qantas", "Earn  1 point\n per $1")])).toBe(
    loyaltyTextHash([feature("Qantas", "Earn 1 point per $1")])
  )
  expect(loyaltyTextHash([feature("Qantas", "Earn 1 point per $1")])).not.toBe(
    loyaltyTextHash([feature("Qantas", "Earn 2 points per $1")])
  )
})

describe("planRewards", () => {
  const simple = [feature("Bendigo Bank Rewards", "Earn 1.5 Bendigo Bank Rewards points for every dollar spent")]

  const complex = [
    feature("Membership Rewards", "2 points per $1 spent on all purchases, excluding government bodies.")
  ]

  const hash = loyaltyTextHash(simple)

  test("parser sets earn for new cards and leaves unchanged ones alone", () => {
    expect(planRewards({ program: "x" }, simple)).toEqual(RewardsPlan.Set({ earn: [{ rate: 1.5 }], hash }))
    expect(
      planRewards({ program: "x", earn: [{ rate: 1.5 }], earn_source: "parser", earn_text_hash: hash }, simple)
    ).toEqual(RewardsPlan.Unchanged())
  })

  test("complex text goes to review", () => {
    expect(planRewards({ program: "x" }, complex)._tag).toBe("Review")
  })

  test("manual earn is never replaced, only re-reviewed when the text changes", () => {
    const manual = { program: "x", earn: [{ rate: 9 }], earn_source: "manual" as const, earn_text_hash: hash }
    expect(planRewards(manual, simple)).toEqual(RewardsPlan.Unchanged())
    expect(planRewards(manual, complex)._tag).toBe("Review")
  })
})
