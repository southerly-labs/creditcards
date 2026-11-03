import type { Api } from "../src/api/contract.ts"
import { required } from "../src/util/required.ts"
import {
  decodeMonthlySpend,
  fetchApi,
  loadColumnVisibility,
  loadMonthlySpend,
  loadPointValues,
  todayInSydney
} from "../src/model/api.ts"
import { encodeJson } from "../src/util/json.ts"
import { FetchHttpClient } from "effect/http"
import { annualPoints, meetsSpendTarget } from "../src/model/benefit.ts"
import type { Card, Program } from "../src/model/schema.ts"
import { offerStatus } from "../src/offers/project.ts"
import type { OfferComponent } from "../src/offers/schema.ts"
import {
  Effect,
  Record as EffectRecord,
  String as EffectString,
  Array as EffectArray,
  pipe,
  Option,
  Order
} from "effect"

interface Row {
  readonly id: string
  readonly issuer: string
  readonly card: Omit<Card, "locked">
  readonly program: (Omit<Program, "aliases" | "priority"> & { readonly id: string }) | undefined
}

type Value = number | string | undefined

interface Column {
  readonly id: string
  readonly label: string
  readonly fixed?: boolean
  readonly hiddenByDefault?: boolean
  readonly num?: boolean
  readonly sortValue: (r: Row) => Value
  readonly render: (r: Row) => string
}

const esc = (s: string) =>
  pipe(
    s,
    EffectString.replaceAll("&", "&amp;"),
    EffectString.replaceAll("<", "&lt;"),
    EffectString.replaceAll(">", "&gt;"),
    EffectString.replaceAll('"', "&quot;"),
    EffectString.replaceAll("'", "&#39;")
  )

const dash = '<span class="dim">—</span>'

const money = (n: number | undefined) =>
  n === undefined
    ? dash
    : n === 0
      ? '<span class="zero">$0</span>'
      : `$${n.toLocaleString("en-AU", { maximumFractionDigits: 2 })}`

const pct = (n: number | undefined) =>
  n === undefined
    ? dash
    : n === 0
      ? '<span class="zero">0%</span>'
      : `${pipe(n.toFixed(2), EffectString.replace(/\.?0+$/u, ""))}%`

const plain = (html: string) => pipe(html, EffectString.replaceAll(/<[^>]+>/gu, ""))

const int = (n: number | undefined) => (n === undefined ? dash : n.toLocaleString("en-AU"))

const introTargets = { purchase: "purchases", balance_transfer: "BT", both: "BT + purchases" } satisfies Record<
  IntroRate["applies_to"],
  string
>

const today = todayInSydney()

const currentOffers = (r: Row) =>
  EffectArray.filter(r.card.offers ?? [], (o) => ["within_window", "undated"].includes(offerStatus(o, today)))

type IntroRate = Extract<OfferComponent, { readonly kind: "intro_rate" }>

type Tranche = Extract<OfferComponent, { readonly kind: "signup_points" }>

type FeeDiscount = Extract<OfferComponent, { readonly kind: "fee_discount" }>

const isIntroRate = (c: OfferComponent): c is IntroRate => c.kind === "intro_rate"

const isTranche = (c: OfferComponent): c is Tranche => c.kind === "signup_points"

const isFeeDiscount = (c: OfferComponent): c is FeeDiscount => c.kind === "fee_discount"

const introRate = (r: Row) =>
  EffectArray.flatMap(currentOffers(r), (o) => EffectArray.filter(o.components, isIntroRate))[0]

const intro = (r: Row) => {
  const offer = introRate(r)

  if (offer === undefined) return undefined
  const what = introTargets[offer.applies_to]

  return `${pct(offer.rate)} ${what}${(offer.months ?? 0) !== 0 ? ` ${offer.months}m` : ""}`
}

type Earn = NonNullable<NonNullable<Card["rewards"]>["earn"]>

const baseEarn = (r: Row) =>
  Option.getOrUndefined(
    EffectArray.findFirst(r.card.rewards?.earn ?? [], (e) => e.category == null || e.category === "")
  )?.rate

const governmentRates = (r: Row) =>
  EffectArray.filter(r.card.rewards?.earn ?? [], (e) => /\bgovernment\b|\btaxation\b/iu.test(e.category ?? ""))

const governmentEarn = (r: Row) => Math.max(0, ...EffectArray.map(governmentRates(r), (e) => e.rate))

const describeEarn = (earn: Earn) => {
  let previousCap: number | undefined

  const describeTier = (e: Earn[number]) => {
    const where =
      e.category != null && e.category !== ""
        ? ` on ${e.category}`
        : e.cap_monthly === undefined
          ? previousCap !== undefined
            ? " thereafter"
            : ""
          : ` up to ${plain(money(e.cap_monthly))} a month`

    if ((e.category == null || e.category === "") && e.cap_monthly !== undefined) previousCap = e.cap_monthly

    return `${e.rate} per $1${where}${e.note != null && e.note !== "" ? ` (${e.note})` : ""}`
  }

  return EffectArray.join(
    EffectArray.map(earn, (e) => describeTier(e)),
    "\n"
  )
}

const OVERRIDES_KEY = "creditcards.pointValues"

const loadOverrides = () => loadPointValues(() => localStorage.getItem(OVERRIDES_KEY))

const overrides: Record<string, number> = loadOverrides()

const saveOverrides = () => {
  localStorage.setItem(OVERRIDES_KEY, encodeJson(overrides))
}

const centsPerPoint = (r: Row) =>
  r.program !== undefined ? (overrides[r.program.id] ?? r.program.cents_per_point) : undefined

const earnValue = (r: Row) => {
  const earn = baseEarn(r)
  const cents = centsPerPoint(r)

  return earn === undefined || cents === undefined ? undefined : Math.round(earn * cents * 1000) / 1000
}

const signup = (r: Row) =>
  Option.getOrUndefined(EffectArray.findFirst(currentOffers(r), (o) => EffectArray.some(o.components, isTranche)))

const tranches = (r: Row): ReadonlyArray<Tranche> | undefined => {
  const offer = signup(r)

  return offer === undefined ? undefined : EffectArray.filter(offer.components, isTranche)
}

const splitKnown = (r: Row) => {
  const offer = signup(r)

  return offer !== undefined && offer.source !== "cdr"
}

const bonusPoints = (r: Row, year?: Tranche["year"]) => {
  const bonus = tranches(r)

  if (bonus === undefined) return undefined

  const points = EffectArray.reduce(
    EffectArray.filter(bonus, (t) => year === undefined || t.year === year),
    0,
    (sum, t) => sum + t.points
  )

  return points === 0 ? undefined : points
}

const describeTranche = (t: Tranche) => {
  const conditions = EffectArray.filter(
    [
      t.min_spend === undefined
        ? ""
        : `spend ${plain(money(t.min_spend))}${t.spend_days === undefined ? "" : ` in ${t.spend_days} days`}`,
      t.keep_months === undefined ? "" : `keep the card ${t.keep_months} months`,
      t.note ?? ""
    ],
    Boolean
  )

  return `${t.year === undefined ? "" : `Year ${t.year}: `}${int(t.points)} points${conditions.length > 0 ? ` (${EffectArray.join(conditions, ", ")})` : ""}`
}

const describeBonus = (r: Row) => {
  if (splitKnown(r))
    return EffectArray.join(
      EffectArray.map(tranches(r) ?? [], (t) => describeTranche(t)),
      "\n"
    )

  return "The issuer's CDR data doesn't say how this bonus is split across years"
}

const pointsValue = (r: Row, points: number | undefined) => {
  const cents = centsPerPoint(r)

  return points === undefined || cents === undefined ? undefined : (points * cents) / 100
}

const bonusValue = (r: Row) => pointsValue(r, bonusPoints(r))

const yearValue = (r: Row, year: 1 | 2) => {
  const points = splitKnown(r) ? bonusPoints(r, year) : undefined

  return points === undefined ? [] : [`Year ${year}: ${plain(money(pointsValue(r, points)))}`]
}

const yearValues = (r: Row) => [...yearValue(r, 1), ...yearValue(r, 2)]

const SPEND_KEY = "creditcards.monthlySpend"

let monthlySpend = loadMonthlySpend(() => localStorage.getItem(SPEND_KEY))

const signedMoney = (n: number) => (n < 0 ? `−${money(-n)}` : money(n))

type Benefit =
  | { readonly kind: "value"; readonly value: number; readonly title: string }
  | { readonly kind: "unknown"; readonly title: string }
  | { readonly kind: "none" }

const firstYearFee = (r: Row) =>
  Option.getOrUndefined(
    EffectArray.findFirst(
      EffectArray.flatMap(currentOffers(r), (o) => EffectArray.filter(o.components, isFeeDiscount)),
      (c) => c.fee === "annual" && (c.months ?? 12) >= 12
    )
  )?.payable ?? r.card.fees.annual

const firstYearTranches = (r: Row) =>
  EffectArray.filter(splitKnown(r) ? (tranches(r) ?? []) : [], (t) => (t.year ?? 1) === 1)

const benefit = (r: Row, firstYear: boolean): Benefit => {
  if (monthlySpend === undefined) return { kind: "none" }
  const spend = monthlySpend
  const fee = firstYear ? firstYearFee(r) : r.card.fees.annual

  if (fee === undefined) return { kind: "unknown", title: "Annual fee unknown" }
  const feeText = `minus ${plain(money(fee))} ${firstYear ? "first-year" : "annual"} fee`

  if (r.program === undefined) return { kind: "value", value: -fee, title: `No rewards, ${feeText}` }
  const points = annualPoints(r.card.rewards?.earn ?? [], spend, r.card.rewards?.earn_rules)

  if (points === undefined) return { kind: "unknown", title: `No base earn rate for ${r.program.name}` }
  const cents = centsPerPoint(r)

  if (cents === undefined) {
    return { kind: "unknown", title: `No point value for ${r.program.name}; set one under Point values` }
  }

  const custom = overrides[r.program.id] !== undefined
  const offered = firstYear ? firstYearTranches(r) : []
  const earned = EffectArray.filter(offered, (t) => meetsSpendTarget(spend, t))
  const missed = EffectArray.filter(offered, (t) => !meetsSpendTarget(spend, t))
  const bonus = EffectArray.reduce(earned, 0, (sum, t) => sum + t.points)

  const title = EffectArray.join(
    [
      `${int(points)} points a year on ${plain(money(spend))} a month`,
      ...EffectArray.map(earned, (t) => `+ ${describeTranche(t)}`),
      ...EffectArray.map(missed, (t) => `Not reached: ${describeTranche(t)}`),
      `× ${cents}c per point${custom ? " (your value)" : ""}`,
      feeText,
      firstYear
        ? "Base earn rate only; excludes category rates and year 2 bonuses"
        : "Base earn rate only; excludes category rates and signup bonuses"
    ],
    "\n"
  )

  return { kind: "value", value: Math.round(((points + bonus) * cents) / 100 - fee), title }
}

const benefitColumn = (id: string, label: string, firstYear: boolean): Column => ({
  id,
  label,
  num: true,
  sortValue: (r) => {
    const b = benefit(r, firstYear)

    return b.kind === "value" ? b.value : undefined
  },
  render: (r) => {
    const b = benefit(r, firstYear)

    if (b.kind === "none") return `<span class="dim" title="Enter your monthly spend to see this">—</span>`

    if (b.kind === "unknown") return `<span class="dim" title="${esc(b.title)}">?</span>`
    const custom = r.program !== undefined && overrides[r.program.id] !== undefined
    const tone = b.value < 0 ? "negative" : custom ? "custom" : ""

    return `<span class="${tone}" title="${esc(b.title)}">${signedMoney(b.value)}</span>`
  }
})

const columns: ReadonlyArray<Column> = [
  {
    id: "card",
    label: "Card",
    fixed: true,
    sortValue: (r) => EffectString.toLowerCase(r.card.name),
    render: (r) => {
      const img =
        r.card.image != null && r.card.image !== ""
          ? `<img src="${esc(r.card.image)}" alt="" loading="lazy" />`
          : '<span class="ph"></span>'

      const name =
        r.card.url != null && r.card.url !== ""
          ? `<a href="${esc(r.card.url)}" target="_blank" rel="noopener">${esc(r.card.name)}</a>`
          : esc(r.card.name)

      return `<div class="card">${img}<div>${name}<div class="issuer">${esc(r.issuer)}</div></div></div>`
    }
  },
  {
    id: "network",
    label: "Network",
    sortValue: (r) => r.card.network,
    render: (r) => (r.card.network !== undefined ? `<span class="tag">${r.card.network}</span>` : dash)
  },
  {
    id: "annual-fee",
    label: "Annual fee",
    num: true,
    sortValue: (r) => r.card.fees.annual,
    render: (r) => money(r.card.fees.annual)
  },
  {
    id: "purchase",
    label: "Purchase",
    hiddenByDefault: true,
    num: true,
    sortValue: (r) => r.card.rates.purchase,
    render: (r) => pct(r.card.rates.purchase)
  },
  {
    id: "cash-advance",
    label: "Cash adv.",
    hiddenByDefault: true,
    num: true,
    sortValue: (r) => r.card.rates.cash_advance,
    render: (r) => pct(r.card.rates.cash_advance)
  },
  {
    id: "intro",
    label: "Intro offer",
    hiddenByDefault: true,
    sortValue: (r) => introRate(r)?.months,
    render: (r) => intro(r) ?? dash
  },
  {
    id: "interest-free-days",
    label: "Int. free days",
    hiddenByDefault: true,
    num: true,
    sortValue: (r) => r.card.rates.interest_free_days,
    render: (r) => int(r.card.rates.interest_free_days)
  },
  {
    id: "fx-fee",
    label: "FX fee",
    num: true,
    sortValue: (r) => r.card.fees.foreign_txn_pct,
    render: (r) => pct(r.card.fees.foreign_txn_pct)
  },
  {
    id: "rewards",
    label: "Rewards",
    sortValue: (r) => r.program?.name,
    render: (r) => (r.program !== undefined ? esc(r.program.name) : dash)
  },
  {
    id: "earn",
    label: "Earn /$",
    num: true,
    sortValue: (r) => baseEarn(r),
    render: (r) => {
      const earn = r.card.rewards?.earn
      const base = baseEarn(r)

      if (earn === undefined || base === undefined) return dash
      const more = earn.length > 1 ? '<span class="dim">+</span>' : ""

      return `<span title="${esc(describeEarn(earn))}">${base}${more}</span>`
    }
  },
  {
    id: "government-earn",
    label: "Government earn",
    num: true,
    sortValue: governmentEarn,
    render: (r) => {
      const rates = governmentRates(r)
      const title = rates.length > 0 ? describeEarn(rates) : "No government earn rate listed; treated as 0"

      return `<span title="${esc(title)}">${governmentEarn(r)} per $1</span>`
    }
  },
  {
    id: "earn-value",
    label: "Value /$",
    num: true,
    sortValue: earnValue,
    render: (r) => {
      const value = earnValue(r)

      if (value === undefined) {
        return baseEarn(r) !== undefined && r.program !== undefined
          ? `<span class="dim" title="No point value for ${esc(r.program.name)}; set one under Point values">?</span>`
          : dash
      }

      const custom = r.program !== undefined && overrides[r.program.id] !== undefined
      const title = `${baseEarn(r)} points per $1 × ${centsPerPoint(r)}c per point${custom ? " (your value)" : ""}`

      return `<span class="${custom ? "custom" : ""}" title="${esc(title)}">${value.toFixed(2)}¢</span>`
    }
  },
  benefitColumn("first-year-value", "First-year value", true),
  benefitColumn("annual-benefit", "Ongoing value", false),
  {
    id: "bonus-points",
    label: "Bonus pts",
    num: true,
    sortValue: (r) => bonusPoints(r),
    render: (r) => {
      const total = bonusPoints(r)

      if (total === undefined) return dash
      const second = bonusPoints(r, 2)

      const split = !splitKnown(r)
        ? '<div class="split">split unknown</div>'
        : second === undefined
          ? ""
          : `<div class="split">${int(bonusPoints(r, 1) ?? 0)} yr 1 · ${int(second)} yr 2</div>`

      return `<span title="${esc(describeBonus(r))}">${int(total)}</span>${split}`
    }
  },
  {
    id: "bonus-first-year",
    label: "Bonus yr 1",
    hiddenByDefault: true,
    num: true,
    sortValue: (r) => (splitKnown(r) ? bonusPoints(r, 1) : undefined),
    render: (r) =>
      !splitKnown(r)
        ? bonusPoints(r) === undefined
          ? dash
          : `<span class="dim" title="${esc(describeBonus(r))}">?</span>`
        : int(bonusPoints(r, 1))
  },
  {
    id: "bonus-value",
    label: "Bonus value",
    num: true,
    sortValue: bonusValue,
    render: (r) => {
      const value = bonusValue(r)

      if (value === undefined) {
        return bonusPoints(r) !== undefined && r.program !== undefined
          ? `<span class="dim" title="No point value for ${esc(r.program.name)}; set one under Point values">?</span>`
          : dash
      }

      const custom = r.program !== undefined && overrides[r.program.id] !== undefined
      const cents = `${centsPerPoint(r)}c per point${custom ? " (your value)" : ""}`

      const title = EffectArray.join(
        [`${int(bonusPoints(r))} bonus points × ${cents}; before annual fees`, ...yearValues(r)],
        "\n"
      )

      return `<span class="${custom ? "custom" : ""}" title="${esc(title)}">${money(value)}</span>`
    }
  },
  {
    id: "min-credit",
    label: "Min credit",
    num: true,
    sortValue: (r) => r.card.limits.min_credit,
    render: (r) => money(r.card.limits.min_credit)
  },
  {
    id: "min-income",
    label: "Min income",
    num: true,
    sortValue: (r) => r.card.limits.min_income,
    render: (r) => money(r.card.limits.min_income)
  },
  {
    id: "perks",
    label: "Perks",
    sortValue: (r) => (r.card.perks.lounge_access === true ? 100 : 0) + (r.card.perks.insurance?.length ?? 0),
    render: (r) =>
      EffectArray.join(
        [
          r.card.perks.lounge_access === true ? '<span class="tag">Lounge</span>' : "",
          r.card.perks.insurance !== undefined && r.card.perks.insurance.length > 0
            ? `<span class="tag" title="${esc(EffectArray.join(r.card.perks.insurance, "\n"))}">${r.card.perks.insurance.length} insurance</span>`
            : ""
        ],
        " "
      ) || dash
  }
]

const element = <T extends HTMLElement>(id: string, kind: { new (): T }): T => {
  const found = document.querySelector(`#${id}`)

  if (!(found instanceof kind)) throw new Error(`Missing or invalid element: ${id}`)

  return found
}

const $ = (id: string) => element(id, HTMLElement)

const api = await Effect.runPromise(fetchApi("/api.json").pipe(Effect.provide(FetchHttpClient.layer)))

const makeRow = (issuerId: string, issuer: Api["issuers"][string], cardId: string, card: Row["card"]): Row => {
  const programId = card.rewards?.program
  const publicProgram = programId === undefined ? undefined : api.programs[programId]

  const program =
    programId !== undefined && publicProgram !== undefined ? { id: programId, ...publicProgram } : undefined

  return { id: `${issuerId}/${cardId}`, issuer: issuer.name, card, program }
}

const rows: ReadonlyArray<Row> = EffectArray.flatMap(EffectRecord.toEntries(api.issuers), ([issuerId, issuer]) =>
  EffectArray.map(EffectRecord.toEntries(issuer.cards), ([cardId, card]) => makeRow(issuerId, issuer, cardId, card))
)

let sortIndex = 2
let sortDir: "asc" | "desc" = "asc"

const COLUMNS_KEY = "creditcards.columns"

const columnChoices: Record<string, boolean> = loadColumnVisibility(() => localStorage.getItem(COLUMNS_KEY))

const isShown = (c: Column) => c.fixed === true || (columnChoices[c.id] ?? c.hiddenByDefault !== true)

const renderColumnPicker = () => {
  $("column-list").innerHTML = EffectArray.join(
    EffectArray.flatMap(columns, (c) =>
      c.fixed === true
        ? []
        : [
            `<label><input type="checkbox" data-column="${esc(c.id)}"${isShown(c) ? " checked" : ""} /> ${esc(c.label)}</label>`
          ]
    ),
    ""
  )
}

const toggleColumn = (e: Event) => {
  const input = e.target

  if (!(input instanceof HTMLInputElement)) return
  const id = input.dataset["column"]
  const column = Option.getOrUndefined(EffectArray.findFirst(columns, (c) => c.id === id))

  if (column === undefined) return

  if (input.checked === (column.hiddenByDefault !== true)) delete columnChoices[column.id]
  else columnChoices[column.id] = input.checked
  localStorage.setItem(COLUMNS_KEY, encodeJson(columnChoices))
  render()
}

$("column-list").addEventListener("change", toggleColumn)

$("column-reset").addEventListener("click", () => {
  for (const id of EffectRecord.keys(columnChoices)) delete columnChoices[id]
  localStorage.setItem(COLUMNS_KEY, encodeJson(columnChoices))
  renderColumnPicker()
  render()
})

const head = $("head")

const sortHead = (e: MouseEvent) => {
  const th = e.target instanceof HTMLElement ? e.target.closest("th") : null

  if (th === null) return
  const i = Number(th.dataset["i"])
  sortDir = i === sortIndex && sortDir === "asc" ? "desc" : "asc"
  sortIndex = i
  render()
}

head.addEventListener("click", sortHead)

const byValue = Order.make<number | string>((a, b) =>
  typeof a === "number" && typeof b === "number"
    ? Order.Number(a, b)
    : pipe(String(a), EffectString.localeCompare(String(b)))
)

const compare = (dir: "asc" | "desc"): Order.Order<Value> =>
  Order.make((a, b) =>
    a === undefined ? (b === undefined ? 0 : 1) : b === undefined ? -1 : dir === "asc" ? byValue(a, b) : byValue(b, a)
  )

const render = () => {
  const q = EffectString.toLowerCase(EffectString.trim(element("search", HTMLInputElement).value))
  const type = element("type", HTMLSelectElement).value
  const program = element("program", HTMLSelectElement).value
  const noFx = element("nofx", HTMLInputElement).checked
  const noFee = element("nofee", HTMLInputElement).checked
  const government = element("government", HTMLInputElement).checked
  const showDisc = element("discontinued", HTMLInputElement).checked

  const matchesFilters = (r: Row) => {
    if (!showDisc && r.card.status !== "active") return false

    if (type !== "" && r.card.type !== type) return false

    if (program === "none" ? r.program !== undefined : program !== "" && r.program?.type !== program) return false

    if (noFx && r.card.fees.foreign_txn_pct !== 0) return false

    if (noFee && r.card.fees.annual !== 0) return false

    if (government && governmentEarn(r) <= 0) return false

    if (
      q !== "" &&
      !pipe(EffectString.toLowerCase(`${r.card.name} ${r.issuer} ${r.program?.name ?? ""}`), EffectString.includes(q))
    )
      return false

    return true
  }

  const visible = EffectArray.filter(rows, (r) => matchesFilters(r))
  const col = required(columns[sortIndex])
  const sorted = EffectArray.sortWith(visible, col.sortValue, compare(sortDir))
  const shown = EffectArray.flatMap(columns, (c, i) => (isShown(c) ? [{ c, i }] : []))

  head.innerHTML = EffectArray.join(
    EffectArray.map(
      shown,
      ({ c, i }) =>
        `<th class="${c.num === true ? "num" : ""}" data-i="${i}"${i === sortIndex ? ` data-dir="${sortDir}"` : ""}>${c.label}</th>`
    ),
    ""
  )

  $("rows").innerHTML = EffectArray.join(
    EffectArray.map(
      sorted,
      (r) =>
        `<tr class="${r.card.status === "active" ? "" : "disc"}">${EffectArray.join(
          EffectArray.map(shown, ({ c }) => `<td class="${c.num === true ? "num" : ""}">${c.render(r)}</td>`),
          ""
        )}</tr>`
    ),
    ""
  )
  $("count").textContent = `${visible.length} of ${rows.length} cards`
}

const renderValueGrid = () => {
  const counts = new Map<string, number>()

  for (const r of rows) if (r.program !== undefined) counts.set(r.program.id, (counts.get(r.program.id) ?? 0) + 1)

  const programs = EffectArray.sort(
    EffectArray.map([...counts.keys()], (id) => ({ id, program: required(api.programs[id]) })),
    Order.combine<{ readonly id: string; readonly program: Api["programs"][string] }>(
      Order.mapInput(Order.flip(Order.Number), (p) => required(counts.get(p.id))),
      Order.make((a, b) => pipe(a.program.name, EffectString.localeCompare(b.program.name)))
    )
  )

  const renderPointValue = (id: string, p: Api["programs"][string]) => {
    const basis = EffectArray.join(
      EffectArray.filter(
        [
          p.value_basis,
          p.value_source,
          p.value_updated != null && p.value_updated !== "" && `Updated ${p.value_updated}`
        ],
        (part): part is string => typeof part === "string" && part !== ""
      ),
      "\n"
    )

    const fallback = p.cents_per_point === undefined ? "no default" : `default ${p.cents_per_point}c`

    return `<label title="${esc(basis || "No default value for this program")}">
      <span>${esc(p.name)}</span>
      <input type="number" min="0" max="10" step="0.01" inputmode="decimal" data-program="${esc(id)}"
        placeholder="${p.cents_per_point ?? ""}" value="${overrides[id] ?? ""}" />
      <span class="dim">c · ${fallback}</span>
    </label>`
  }

  const renderGroup = (type: Program["type"], title: string) => {
    const entries = EffectArray.filter(programs, ({ program }) => program.type === type)

    if (entries.length === 0) return ""

    return `<section class="value-group"><h3>${title}</h3><div class="value-grid">${EffectArray.join(
      EffectArray.map(entries, ({ id, program }) => renderPointValue(id, program)),
      ""
    )}</div></section>`
  }

  const otherGroups = EffectArray.join(
    [renderGroup("bank", "Bank rewards"), renderGroup("retail", "Retail rewards"), renderGroup("cashback", "Cashback")],
    ""
  )

  $("value-grid").innerHTML = `${renderGroup("airline", "Frequent flyer programs")}${
    otherGroups === ""
      ? ""
      : `<details class="other-values"><summary>Other program values</summary>${otherGroups}</details>`
  }`
}

const updatePointValue = (e: Event) => {
  const input = e.target

  if (!(input instanceof HTMLInputElement)) return
  const id = input.dataset["program"]

  if (id == null || id === "") return
  const value = EffectString.trim(input.value) === "" ? NaN : Number(input.value)

  if (Number.isFinite(value) && value >= 0) overrides[id] = value
  else delete overrides[id]
  saveOverrides()
  render()
}

$("value-grid").addEventListener("input", updatePointValue)

$("value-reset").addEventListener("click", () => {
  for (const id of EffectRecord.keys(overrides)) delete overrides[id]
  saveOverrides()
  renderValueGrid()
  render()
})

const spendInput = element("spend", HTMLInputElement)

spendInput.value = monthlySpend === undefined ? "" : String(monthlySpend)

spendInput.addEventListener("input", () => {
  monthlySpend = decodeMonthlySpend(spendInput.value)

  if (monthlySpend === undefined) localStorage.removeItem(SPEND_KEY)
  else localStorage.setItem(SPEND_KEY, String(monthlySpend))
  render()
})

renderValueGrid()

renderColumnPicker()

for (const id of ["search", "type", "program", "nofx", "nofee", "government", "discontinued"]) {
  $(id).addEventListener("input", render)
}

render()
