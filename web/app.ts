import type { Api } from "../src/build/build.ts"
import { required } from "../src/util/required.ts"
import { decodeApi, loadPointValues } from "../src/model/api.ts"
import type { Card, IntroOffer, Program } from "../src/model/schema.ts"

interface Row {
  readonly id: string
  readonly issuer: string
  readonly card: Omit<Card, "locked">
  readonly program: (Omit<Program, "aliases" | "priority"> & { readonly id: string }) | undefined
}

type Value = number | string | undefined

interface Column {
  readonly label: string
  readonly num?: boolean
  readonly sortValue: (r: Row) => Value
  readonly render: (r: Row) => string
}

const esc = (s: string) =>
  s.replaceAll(/[&<>"']/gu, (c) => required({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))

const dash = '<span class="dim">—</span>'

const money = (n: number | undefined) =>
  n === undefined
    ? dash
    : n === 0
      ? '<span class="zero">$0</span>'
      : `$${n.toLocaleString("en-AU", { maximumFractionDigits: 2 })}`

const pct = (n: number | undefined) =>
  n === undefined ? dash : n === 0 ? '<span class="zero">0%</span>' : `${n.toFixed(2).replace(/\.?0+$/u, "")}%`

const int = (n: number | undefined) => (n === undefined ? dash : n.toLocaleString("en-AU"))

const introTargets = { purchase: "purchases", balance_transfer: "BT", both: "BT + purchases" } satisfies Record<
  IntroOffer["applies_to"],
  string
>

const intro = (r: Row) => {
  const offer = r.card.rates.intro?.[0]

  if (!offer) return undefined
  const what = introTargets[offer.applies_to]

  return `${pct(offer.rate)} ${what}${(offer.months ?? 0) !== 0 ? ` ${offer.months}m` : ""}`
}

type Earn = NonNullable<NonNullable<Card["rewards"]>["earn"]>

const baseEarn = (r: Row) => r.card.rewards?.earn?.find((e) => e.category == null || e.category === "")?.rate

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
          : ` up to ${money(e.cap_monthly).replaceAll(/<[^>]+>/gu, "")} a month`

    if ((e.category == null || e.category === "") && e.cap_monthly !== undefined) previousCap = e.cap_monthly

    return `${e.rate} per $1${where}${e.note != null && e.note !== "" ? ` (${e.note})` : ""}`
  }

  return earn.map((e) => describeTier(e)).join("\n")
}

const OVERRIDES_KEY = "creditcards.pointValues"

const loadOverrides = () => loadPointValues(() => localStorage.getItem(OVERRIDES_KEY))

const overrides: Record<string, number> = loadOverrides()

const saveOverrides = () => {
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides))
}

const centsPerPoint = (r: Row) => (r.program ? (overrides[r.program.id] ?? r.program.cents_per_point) : undefined)

const earnValue = (r: Row) => {
  const earn = baseEarn(r)
  const cents = centsPerPoint(r)

  return earn === undefined || cents === undefined ? undefined : Math.round(earn * cents * 1000) / 1000
}

const columns: ReadonlyArray<Column> = [
  {
    label: "Card",
    sortValue: (r) => r.card.name.toLowerCase(),
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
    label: "Network",
    sortValue: (r) => r.card.network,
    render: (r) => (r.card.network ? `<span class="tag">${r.card.network}</span>` : dash)
  },
  { label: "Annual fee", num: true, sortValue: (r) => r.card.fees.annual, render: (r) => money(r.card.fees.annual) },
  { label: "Purchase", num: true, sortValue: (r) => r.card.rates.purchase, render: (r) => pct(r.card.rates.purchase) },
  {
    label: "Cash adv.",
    num: true,
    sortValue: (r) => r.card.rates.cash_advance,
    render: (r) => pct(r.card.rates.cash_advance)
  },
  { label: "Intro offer", sortValue: (r) => r.card.rates.intro?.[0]?.months, render: (r) => intro(r) ?? dash },
  {
    label: "Int. free days",
    num: true,
    sortValue: (r) => r.card.rates.interest_free_days,
    render: (r) => int(r.card.rates.interest_free_days)
  },
  {
    label: "FX fee",
    num: true,
    sortValue: (r) => r.card.fees.foreign_txn_pct,
    render: (r) => pct(r.card.fees.foreign_txn_pct)
  },
  { label: "Rewards", sortValue: (r) => r.program?.name, render: (r) => (r.program ? esc(r.program.name) : dash) },
  {
    label: "Earn /$",
    num: true,
    sortValue: (r) => baseEarn(r),
    render: (r) => {
      const earn = r.card.rewards?.earn
      const base = baseEarn(r)

      if (!earn || base === undefined) return dash
      const more = earn.length > 1 ? '<span class="dim">+</span>' : ""

      return `<span title="${esc(describeEarn(earn))}">${base}${more}</span>`
    }
  },
  {
    label: "Value /$",
    num: true,
    sortValue: earnValue,
    render: (r) => {
      const value = earnValue(r)

      if (value === undefined) {
        return baseEarn(r) !== undefined && r.program
          ? `<span class="dim" title="No point value for ${esc(r.program.name)}; set one under Point values">?</span>`
          : dash
      }

      const custom = r.program !== undefined && overrides[r.program.id] !== undefined
      const title = `${baseEarn(r)} points per $1 × ${centsPerPoint(r)}c per point${custom ? " (your value)" : ""}`

      return `<span class="${custom ? "custom" : ""}" title="${esc(title)}">${value.toFixed(2)}¢</span>`
    }
  },
  {
    label: "Bonus pts",
    num: true,
    sortValue: (r) => r.card.rewards?.bonus_points,
    render: (r) => int(r.card.rewards?.bonus_points)
  },
  {
    label: "Min credit",
    num: true,
    sortValue: (r) => r.card.limits.min_credit,
    render: (r) => money(r.card.limits.min_credit)
  },
  {
    label: "Min income",
    num: true,
    sortValue: (r) => r.card.limits.min_income,
    render: (r) => money(r.card.limits.min_income)
  },
  {
    label: "Perks",
    sortValue: (r) => (r.card.perks.lounge_access === true ? 100 : 0) + (r.card.perks.insurance?.length ?? 0),
    render: (r) =>
      [
        r.card.perks.lounge_access === true ? '<span class="tag">Lounge</span>' : "",
        r.card.perks.insurance !== undefined && r.card.perks.insurance.length > 0
          ? `<span class="tag" title="${esc(r.card.perks.insurance.join("\n"))}">${r.card.perks.insurance.length} insurance</span>`
          : ""
      ].join(" ") || dash
  }
]

const element = <T extends HTMLElement>(id: string, kind: { new (): T }): T => {
  const found = document.querySelector(`#${id}`)

  if (!(found instanceof kind)) throw new Error(`Missing or invalid element: ${id}`)

  return found
}

const $ = (id: string) => element(id, HTMLElement)

const api = decodeApi(await fetch("/api.json").then((r): Promise<unknown> => r.json()))

const makeRow = (issuerId: string, issuer: Api["issuers"][string], cardId: string, card: Row["card"]): Row => {
  const programId = card.rewards?.program
  const publicProgram = programId === undefined ? undefined : api.programs[programId]

  const program =
    programId !== undefined && publicProgram !== undefined ? { id: programId, ...publicProgram } : undefined

  return { id: `${issuerId}/${cardId}`, issuer: issuer.name, card, program }
}

const rows: ReadonlyArray<Row> = Object.entries(api.issuers).flatMap(([issuerId, issuer]) =>
  Object.entries(issuer.cards).map(([cardId, card]) => makeRow(issuerId, issuer, cardId, card))
)

let sortIndex = 2
let sortDir: "asc" | "desc" = "asc"

const head = $("head")

head.innerHTML = columns
  .map((c, i) => `<th class="${c.num === true ? "num" : ""}" data-i="${i}">${c.label}</th>`)
  .join("")

const sortHead = (e: MouseEvent) => {
  const th = e.target instanceof HTMLElement ? e.target.closest("th") : null

  if (!th) return
  const i = Number(th.dataset["i"])
  sortDir = i === sortIndex && sortDir === "asc" ? "desc" : "asc"
  sortIndex = i
  render()
}

head.addEventListener("click", sortHead)

const compare = (a: Value, b: Value) => {
  if (a === undefined) return b === undefined ? 0 : 1

  if (b === undefined) return -1
  const d = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b))

  return sortDir === "asc" ? d : -d
}

const render = () => {
  const q = element("search", HTMLInputElement).value.trim().toLowerCase()
  const type = element("type", HTMLSelectElement).value
  const program = element("program", HTMLSelectElement).value
  const noFx = element("nofx", HTMLInputElement).checked
  const noFee = element("nofee", HTMLInputElement).checked
  const showDisc = element("discontinued", HTMLInputElement).checked

  const matchesFilters = (r: Row) => {
    if (!showDisc && r.card.status !== "active") return false

    if (type && r.card.type !== type) return false

    if (program === "none" ? r.program !== undefined : program !== "" && r.program?.type !== program) return false

    if (noFx && r.card.fees.foreign_txn_pct !== 0) return false

    if (noFee && r.card.fees.annual !== 0) return false

    if (q && !`${r.card.name} ${r.issuer} ${r.program?.name ?? ""}`.toLowerCase().includes(q)) return false

    return true
  }

  const visible = rows.filter((r) => matchesFilters(r))
  const col = required(columns[sortIndex])
  const sorted = visible.toSorted((a, b) => compare(col.sortValue(a), col.sortValue(b)))

  for (const th of head.querySelectorAll("th")) {
    if (Number(th.dataset["i"]) === sortIndex) th.dataset["dir"] = sortDir
    else delete th.dataset["dir"]
  }

  $("rows").innerHTML = sorted
    .map(
      (r) =>
        `<tr class="${r.card.status === "active" ? "" : "disc"}">${columns.map((c) => `<td class="${c.num === true ? "num" : ""}">${c.render(r)}</td>`).join("")}</tr>`
    )
    .join("")
  $("count").textContent = `${visible.length} of ${rows.length} cards`
}

const renderValueGrid = () => {
  const counts = new Map<string, number>()

  for (const r of rows) if (r.program) counts.set(r.program.id, (counts.get(r.program.id) ?? 0) + 1)

  const programs = [...counts.keys()]
    .map((id) => ({ id, program: required(api.programs[id]) }))
    .toSorted(
      (a, b) => required(counts.get(b.id)) - required(counts.get(a.id)) || a.program.name.localeCompare(b.program.name)
    )

  const renderPointValue = (id: string, p: Api["programs"][string]) => {
    const basis = [
      p.value_basis,
      p.value_source,
      p.value_updated != null && p.value_updated !== "" && `Updated ${p.value_updated}`
    ]
      .filter(Boolean)
      .join("\n")

    const fallback = p.cents_per_point === undefined ? "no default" : `default ${p.cents_per_point}c`

    return `<label title="${esc(basis || "No default value for this program")}">
      <span>${esc(p.name)}</span>
      <input type="number" min="0" max="10" step="0.01" inputmode="decimal" data-program="${esc(id)}"
        placeholder="${p.cents_per_point ?? ""}" value="${overrides[id] ?? ""}" />
      <span class="dim">c · ${fallback}</span>
    </label>`
  }

  $("value-grid").innerHTML = programs.map(({ id, program }) => renderPointValue(id, program)).join("")
}

const updatePointValue = (e: Event) => {
  const input = e.target

  if (!(input instanceof HTMLInputElement)) return
  const id = input.dataset["program"]

  if (id == null || id === "") return
  const value = input.value.trim() === "" ? NaN : Number(input.value)

  if (Number.isFinite(value) && value >= 0) overrides[id] = value
  else delete overrides[id]
  saveOverrides()
  render()
}

$("value-grid").addEventListener("input", updatePointValue)

$("value-reset").addEventListener("click", () => {
  for (const id of Object.keys(overrides)) delete overrides[id]
  saveOverrides()
  renderValueGrid()
  render()
})

renderValueGrid()

for (const id of ["search", "type", "program", "nofx", "nofee", "discontinued"]) {
  $(id).addEventListener("input", render)
}

render()
