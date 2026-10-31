import type { Api } from "../src/build/build.ts"
import type { Card, Program } from "../src/model/schema.ts"

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
  readonly sort: (r: Row) => Value
  readonly render: (r: Row) => string
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)

const dash = '<span class="dim">—</span>'
const money = (n: number | undefined) =>
  n === undefined
    ? dash
    : n === 0
      ? '<span class="zero">$0</span>'
      : `$${n.toLocaleString("en-AU", { maximumFractionDigits: 2 })}`
const pct = (n: number | undefined) =>
  n === undefined ? dash : n === 0 ? '<span class="zero">0%</span>' : `${n.toFixed(2).replace(/\.?0+$/, "")}%`
const int = (n: number | undefined) => (n === undefined ? dash : n.toLocaleString("en-AU"))

const intro = (r: Row) => {
  const offer = r.card.rates.intro?.[0]
  if (!offer) return undefined
  const what =
    offer.applies_to === "balance_transfer" ? "BT" : offer.applies_to === "purchase" ? "purchases" : "BT + purchases"
  return `${pct(offer.rate)} ${what}${offer.months ? ` ${offer.months}m` : ""}`
}

type Earn = NonNullable<NonNullable<Card["rewards"]>["earn"]>

// Points per dollar on the first tier of everyday (uncategorised) spend.
const baseEarn = (r: Row) => r.card.rewards?.earn?.find((e) => !e.category)?.rate

const describeEarn = (earn: Earn) => {
  let previousCap: number | undefined
  return earn
    .map((e) => {
      const where = e.category
        ? ` on ${e.category}`
        : e.cap_monthly !== undefined
          ? ` up to ${money(e.cap_monthly).replace(/<[^>]+>/g, "")} a month`
          : previousCap !== undefined
            ? " thereafter"
            : ""
      if (!e.category && e.cap_monthly !== undefined) previousCap = e.cap_monthly
      return `${e.rate} per $1${where}${e.note ? ` (${e.note})` : ""}`
    })
    .join("\n")
}

// ---- Point values -------------------------------------------------------------
// Defaults come from each program's cents_per_point; users can override any
// program, and overrides persist in localStorage.

const OVERRIDES_KEY = "creditcards.pointValues"

const loadOverrides = (): Record<string, number> => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(OVERRIDES_KEY) ?? "{}")
    return parsed && typeof parsed === "object"
      ? Object.fromEntries(
          Object.entries(parsed).filter(([, v]) => typeof v === "number" && Number.isFinite(v) && v >= 0)
        )
      : {}
  } catch {
    return {}
  }
}

const overrides: Record<string, number> = loadOverrides()
const saveOverrides = () => localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides))

const centsPerPoint = (r: Row) => (r.program ? (overrides[r.program.id] ?? r.program.cents_per_point) : undefined)

// Cents back per $1 of everyday spend.
const earnValue = (r: Row) => {
  const earn = baseEarn(r)
  const cents = centsPerPoint(r)
  return earn === undefined || cents === undefined ? undefined : Math.round(earn * cents * 1000) / 1000
}

const columns: ReadonlyArray<Column> = [
  {
    label: "Card",
    sort: (r) => r.card.name.toLowerCase(),
    render: (r) => {
      const img = r.card.image ? `<img src="${esc(r.card.image)}" alt="" loading="lazy" />` : '<span class="ph"></span>'
      const name = r.card.url
        ? `<a href="${esc(r.card.url)}" target="_blank" rel="noopener">${esc(r.card.name)}</a>`
        : esc(r.card.name)
      return `<div class="card">${img}<div>${name}<div class="issuer">${esc(r.issuer)}</div></div></div>`
    }
  },
  {
    label: "Network",
    sort: (r) => r.card.network,
    render: (r) => (r.card.network ? `<span class="tag">${r.card.network}</span>` : dash)
  },
  { label: "Annual fee", num: true, sort: (r) => r.card.fees.annual, render: (r) => money(r.card.fees.annual) },
  { label: "Purchase", num: true, sort: (r) => r.card.rates.purchase, render: (r) => pct(r.card.rates.purchase) },
  {
    label: "Cash adv.",
    num: true,
    sort: (r) => r.card.rates.cash_advance,
    render: (r) => pct(r.card.rates.cash_advance)
  },
  { label: "Intro offer", sort: (r) => r.card.rates.intro?.[0]?.months, render: (r) => intro(r) ?? dash },
  {
    label: "Int. free days",
    num: true,
    sort: (r) => r.card.rates.interest_free_days,
    render: (r) => int(r.card.rates.interest_free_days)
  },
  {
    label: "FX fee",
    num: true,
    sort: (r) => r.card.fees.foreign_txn_pct,
    render: (r) => pct(r.card.fees.foreign_txn_pct)
  },
  { label: "Rewards", sort: (r) => r.program?.name, render: (r) => (r.program ? esc(r.program.name) : dash) },
  {
    label: "Earn /$",
    num: true,
    sort: (r) => baseEarn(r),
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
    sort: earnValue,
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
    sort: (r) => r.card.rewards?.bonus_points,
    render: (r) => int(r.card.rewards?.bonus_points)
  },
  {
    label: "Min credit",
    num: true,
    sort: (r) => r.card.limits.min_credit,
    render: (r) => money(r.card.limits.min_credit)
  },
  {
    label: "Min income",
    num: true,
    sort: (r) => r.card.limits.min_income,
    render: (r) => money(r.card.limits.min_income)
  },
  {
    label: "Perks",
    sort: (r) => (r.card.perks.lounge_access ? 100 : 0) + (r.card.perks.insurance?.length ?? 0),
    render: (r) =>
      [
        r.card.perks.lounge_access ? '<span class="tag">Lounge</span>' : "",
        r.card.perks.insurance?.length
          ? `<span class="tag" title="${esc(r.card.perks.insurance.join("\n"))}">${r.card.perks.insurance.length} insurance</span>`
          : ""
      ].join(" ") || dash
  }
]

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const api: Api = await fetch("/api.json").then((r) => r.json())

const rows: ReadonlyArray<Row> = Object.entries(api.issuers).flatMap(([issuerId, issuer]) =>
  Object.entries(issuer.cards).map(([cardId, card]) => {
    const programId = card.rewards?.program
    const program = programId && api.programs[programId] ? { id: programId, ...api.programs[programId] } : undefined
    return { id: `${issuerId}/${cardId}`, issuer: issuer.name, card, program }
  })
)

let sortIndex = 2
let sortDir: "asc" | "desc" = "asc"

const head = $("head")
head.innerHTML = columns.map((c, i) => `<th class="${c.num ? "num" : ""}" data-i="${i}">${c.label}</th>`).join("")
head.addEventListener("click", (e) => {
  const th = (e.target as HTMLElement).closest("th")
  if (!th) return
  const i = Number(th.dataset.i)
  sortDir = i === sortIndex && sortDir === "asc" ? "desc" : "asc"
  sortIndex = i
  render()
})

const compare = (a: Value, b: Value) => {
  // Missing values always sort last, whatever the direction.
  if (a === undefined) return b === undefined ? 0 : 1
  if (b === undefined) return -1
  const d = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b))
  return sortDir === "asc" ? d : -d
}

const render = () => {
  const q = $<HTMLInputElement>("search").value.trim().toLowerCase()
  const type = $<HTMLSelectElement>("type").value
  const program = $<HTMLSelectElement>("program").value
  const noFx = $<HTMLInputElement>("nofx").checked
  const noFee = $<HTMLInputElement>("nofee").checked
  const showDisc = $<HTMLInputElement>("discontinued").checked

  const visible = rows.filter((r) => {
    if (!showDisc && r.card.status !== "active") return false
    if (type && r.card.type !== type) return false
    if (program === "none" ? r.program !== undefined : program && r.program?.type !== program) return false
    if (noFx && r.card.fees.foreign_txn_pct !== 0) return false
    if (noFee && r.card.fees.annual !== 0) return false
    if (q && !`${r.card.name} ${r.issuer} ${r.program?.name ?? ""}`.toLowerCase().includes(q)) return false
    return true
  })
  const col = columns[sortIndex]!
  visible.sort((a, b) => compare(col.sort(a), col.sort(b)))

  for (const th of head.querySelectorAll("th")) {
    if (Number(th.dataset.i) === sortIndex) th.dataset.dir = sortDir
    else delete th.dataset.dir
  }
  $("rows").innerHTML = visible
    .map(
      (r) =>
        `<tr class="${r.card.status !== "active" ? "disc" : ""}">${columns.map((c) => `<td class="${c.num ? "num" : ""}">${c.render(r)}</td>`).join("")}</tr>`
    )
    .join("")
  $("count").textContent = `${visible.length} of ${rows.length} cards`
}

const renderValueGrid = () => {
  const counts = new Map<string, number>()
  for (const r of rows) if (r.program) counts.set(r.program.id, (counts.get(r.program.id) ?? 0) + 1)
  const programs = [...counts.keys()]
    .map((id) => ({ id, ...api.programs[id]! }))
    .sort((a, b) => counts.get(b.id)! - counts.get(a.id)! || a.name.localeCompare(b.name))
  $("value-grid").innerHTML = programs
    .map((p) => {
      const basis = [p.value_basis, p.value_source, p.value_updated && `Updated ${p.value_updated}`]
        .filter(Boolean)
        .join("\n")
      const fallback = p.cents_per_point === undefined ? "no default" : `default ${p.cents_per_point}c`
      return `<label title="${esc(basis || "No default value for this program")}">
      <span>${esc(p.name)}</span>
      <input type="number" min="0" max="10" step="0.01" inputmode="decimal" data-program="${esc(p.id)}"
        placeholder="${p.cents_per_point ?? ""}" value="${overrides[p.id] ?? ""}" />
      <span class="dim">c · ${fallback}</span>
    </label>`
    })
    .join("")
}

$("value-grid").addEventListener("input", (e) => {
  const input = e.target as HTMLInputElement
  const id = input.dataset.program
  if (!id) return
  const value = input.value.trim() === "" ? NaN : Number(input.value)
  if (Number.isFinite(value) && value >= 0) overrides[id] = value
  else delete overrides[id]
  saveOverrides()
  render()
})

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
