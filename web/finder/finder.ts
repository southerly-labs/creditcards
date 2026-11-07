import type { Api } from "../../src/api/contract.ts"
import {
  attempt,
  decodeMonthlySpend,
  fetchApi,
  loadMonthlySpend,
  loadPointValues,
  todayInSydney
} from "../../src/model/api.ts"
import { encodeJson } from "../../src/util/json.ts"
import { FetchHttpClient } from "effect/http"
import type { Offer, OfferComponent } from "../../src/offers/schema.ts"
import { required } from "../../src/util/required.ts"
import {
  baseEarnRate,
  currentOffers,
  entriesFrom,
  goalIds,
  goals,
  isBaseRate,
  isGoalId,
  rank as rankRows,
  transferOffer,
  value,
  type Entry,
  type GoalId,
  type Ranked,
  type SignupPoints
} from "./model.ts"
import {
  type DialogName,
  DialogEvent,
  DialogState,
  openDialog,
  stepDialog,
  stepTray,
  TrayEvent,
  TrayState,
  trayIds,
  trayOf
} from "./ui.ts"
import {
  Effect,
  Record as EffectRecord,
  String as EffectString,
  Array as EffectArray,
  pipe,
  Option,
  Order,
  DateTime
} from "effect"

const MOTION = {
  sheetMs: 280,
  listStaggerMs: 18,
  listStaggerCap: 12
}

const SPEND_STOPS = [
  ...Array.from({ length: 21 }, (_, i) => i * 250),
  ...Array.from({ length: 10 }, (_, i) => 5500 + i * 500),
  ...Array.from({ length: 20 }, (_, i) => 11_000 + i * 1000),
  ...Array.from({ length: 10 }, (_, i) => 35_000 + i * 5000)
]

const DEFAULT_SPEND = 2000
const COMPARE_LIMIT = 4
const SPEND_KEY = "creditcards.monthlySpend"
const OVERRIDES_KEY = "creditcards.pointValues"

const typeOptions = [
  { id: "personal", label: "Personal" },
  { id: "business", label: "Business" },
  { id: "all", label: "All" }
] as const

const kindOptions = [
  { id: "any", label: "Any rewards" },
  { id: "airline", label: "Frequent flyer" },
  { id: "points", label: "Bank & store points" },
  { id: "cashback", label: "Cashback" },
  { id: "none", label: "No rewards" }
] as const

const viewOptions = [
  { id: "list", label: "Ranked" },
  { id: "map", label: "Map" }
] as const

type TypeId = (typeof typeOptions)[number]["id"]

type KindId = (typeof kindOptions)[number]["id"]

type ViewId = (typeof viewOptions)[number]["id"]

const oneOf = <T extends string>(options: ReadonlyArray<{ readonly id: T }>, text: string | null, fallback: T): T =>
  Option.getOrUndefined(EffectArray.findFirst(options, (o) => o.id === text))?.id ?? fallback

const esc = (s: string) =>
  pipe(
    s,
    EffectString.replaceAll("&", "&amp;"),
    EffectString.replaceAll("<", "&lt;"),
    EffectString.replaceAll(">", "&gt;"),
    EffectString.replaceAll('"', "&quot;"),
    EffectString.replaceAll("'", "&#39;")
  )

const whole = (n: number) => Math.round(n).toLocaleString("en-AU")

const money = (n: number) =>
  `$${n.toLocaleString("en-AU", { maximumFractionDigits: Number.isInteger(n) || Math.abs(n) >= 100 ? 0 : 2 })}`

const signed = (n: number) => {
  const rounded = Math.round(n)

  if (rounded === 0) return "$0"

  return rounded < 0 ? `−${money(-rounded)}` : `+${money(rounded)}`
}

const pct = (n: number) => `${pipe(n.toFixed(2), EffectString.replace(/\.?0+$/u, ""))}%`

const compactPoints = (n: number) =>
  n >= 1000 ? `${(n / 1000).toLocaleString("en-AU", { maximumFractionDigits: 1 })}k` : whole(n)

const element = <T extends HTMLElement>(id: string, kind: { new (): T }): T => {
  const found = document.querySelector(`#${id}`)

  if (!(found instanceof kind)) throw new Error(`Missing or invalid element: ${id}`)

  return found
}

const $ = (id: string) => element(id, HTMLElement)

const today = todayInSydney()

const api: Api = await Effect.runPromise(fetchApi("/api.json").pipe(Effect.provide(FetchHttpClient.layer)))

const entries = entriesFrom(api)

const entryById = new Map(EffectArray.map(entries, (e) => [e.id, e]))

const readStorage = (key: string) => () => localStorage.getItem(key)

const overrides: Record<string, number> = loadPointValues(readStorage(OVERRIDES_KEY))

const params = new URLSearchParams(pipe(location.hash, EffectString.slice(1)))

const goalParam = params.get("goal")

const state: {
  spend: number
  goal: GoalId
  type: TypeId
  kind: KindId
  view: ViewId
  query: string
  compare: ReadonlyArray<string>
  card: string
} = {
  spend: decodeMonthlySpend(params.get("spend")) ?? loadMonthlySpend(readStorage(SPEND_KEY)) ?? DEFAULT_SPEND,
  goal: isGoalId(goalParam) ? goalParam : "value",
  type: oneOf<TypeId>(typeOptions, params.get("type"), "personal"),
  kind: oneOf<KindId>(kindOptions, params.get("kind"), "any"),
  view: oneOf<ViewId>(viewOptions, params.get("view"), "list"),
  query: params.get("q") ?? "",
  compare: EffectArray.filter(EffectString.split(params.get("compare") ?? "", ","), (id) => entryById.has(id)).slice(
    0,
    COMPARE_LIMIT
  ),
  card: params.get("card") ?? ""
}

let openUi: DialogState = DialogState.cases.Browsing.make({})

let compareTray: TrayState = trayOf(state.compare)

const sendTray = (event: TrayEvent) => {
  compareTray = Effect.runSync(stepTray(compareTray, event))
  state.compare = trayIds(compareTray)
}

const goalOf = () => state.goal

const writeHash = () => {
  const next = new URLSearchParams()

  if (state.spend !== DEFAULT_SPEND) next.set("spend", String(state.spend))

  if (state.goal !== "value") next.set("goal", state.goal)

  if (state.type !== "personal") next.set("type", state.type)

  if (state.kind !== "any") next.set("kind", state.kind)

  if (state.view !== "list") next.set("view", state.view)

  if (state.query !== "") next.set("q", state.query)

  if (state.compare.length > 0) next.set("compare", EffectArray.join(state.compare, ","))

  if (state.card !== "") next.set("card", state.card)
  const hash = next.toString()

  history.replaceState(null, "", hash === "" ? location.pathname : `#${hash}`)
}

const valued = (): ReadonlyArray<Ranked> =>
  EffectArray.map(entries, (entry) => ({ entry, valuation: value(entry, state.spend, overrides, today) }))

const matchesType = (e: Entry) =>
  state.type === "all" || (state.type === "personal" ? e.card.type === "personal" : e.card.type !== "personal")

const kindMatchers: Record<KindId, (programType: string | undefined) => boolean> = {
  any: () => true,
  none: (t) => t === undefined,
  points: (t) => t === "bank" || t === "retail",
  airline: (t) => t === "airline",
  cashback: (t) => t === "cashback"
}

const matchesKind = (e: Entry) => kindMatchers[state.kind](e.program?.type)

const matchesQuery = (e: Entry) => {
  const q = EffectString.toLowerCase(EffectString.trim(state.query))

  return (
    q === "" ||
    pipe(EffectString.toLowerCase(`${e.card.name} ${e.issuer} ${e.program?.name ?? ""}`), EffectString.includes(q))
  )
}

const visibleRows = () =>
  rankRows(
    EffectArray.filter(
      valued(),
      (r) => r.entry.card.status === "active" && matchesType(r.entry) && matchesKind(r.entry) && matchesQuery(r.entry)
    ),
    goalOf(),
    today
  )

const hue = (text: string) =>
  EffectArray.reduce(
    Array.from({ length: text.length }, (_, i) => Option.getOrUndefined(EffectString.codePointAt(text, i)) ?? 0),
    7,
    (h, c) => (h * 31 + c) % 360
  )

const networkNames = { visa: "VISA", mastercard: "mastercard", amex: "AMEX", unionpay: "UnionPay", eftpos: "eftpos" }

const art = (e: Entry, size: "s" | "m" | "l") => {
  const fallback = `<span class="art-fallback" style="--h:${hue(e.issuerId)}"><b>${esc(e.issuer)}</b><i>${
    e.card.network === undefined ? "" : networkNames[e.card.network]
  }</i></span>`

  const img =
    e.card.image === undefined
      ? ""
      : `<img src="${esc(e.card.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`

  return `<span class="art art-${size}">${fallback}${img}</span>`
}

interface Headline {
  readonly figure: string
  readonly caption: string
  readonly tone: "up" | "down" | "flat" | "unknown"
}

const unknownReason = (r: Ranked) => {
  const { entry, valuation } = r

  if (valuation.fee === undefined) return "Annual fee not published"

  if (entry.program !== undefined && valuation.yearlyPoints === undefined) return "Earn rate not published yet"

  if (entry.program !== undefined && valuation.centsPerPoint === undefined) return "Set a value for these points"

  return "Not enough data"
}

const toneOf = (n: number): Headline["tone"] => {
  if (Math.round(n) === 0) return "flat"

  return n > 0 ? "up" : "down"
}

const yearly = (r: Ranked): Headline =>
  r.valuation.ongoing === undefined
    ? { figure: "?", caption: unknownReason(r), tone: "unknown" }
    : { figure: signed(r.valuation.ongoing), caption: "a year, after the fee", tone: toneOf(r.valuation.ongoing) }

const purchaseRate = (r: Ranked): Headline => {
  const purchase = r.entry.card.rates.purchase

  return purchase === undefined
    ? { figure: "?", caption: "Rate not published", tone: "unknown" }
    : { figure: pct(purchase), caption: "a year on purchases", tone: "flat" }
}

const transferTerms = (r: Ranked): Headline => {
  const offer = transferOffer(r.entry.card, today)

  if (offer === undefined) return { figure: "?", caption: "No transfer offer", tone: "unknown" }

  return {
    figure: pct(offer.rate),
    caption: offer.months === undefined ? "on transferred balances" : `for ${offer.months} months on transfers`,
    tone: "flat"
  }
}

const firstYearHeadline = (r: Ranked): Headline =>
  r.valuation.firstYear === undefined
    ? { figure: "?", caption: unknownReason(r), tone: "unknown" }
    : { figure: signed(r.valuation.firstYear), caption: "in year one, after fees", tone: toneOf(r.valuation.firstYear) }

const headlines: Record<GoalId, (r: Ranked) => Headline> = {
  value: yearly,
  bonus: firstYearHeadline,
  travel: yearly,
  rate: purchaseRate,
  transfer: transferTerms,
  free: yearly
}

const headline = (r: Ranked) => headlines[goalOf()](r)

const facts = (r: Ranked) => {
  const { card, program } = r.entry
  const v = r.valuation
  const fee = v.fee

  const feeText =
    fee === undefined
      ? "Fee unknown"
      : fee === 0
        ? "No annual fee"
        : `${money(fee)} fee${v.firstYearFee !== undefined && v.firstYearFee < fee ? ` · ${money(v.firstYearFee)} in year one` : ""}`

  const fx = card.fees.foreign_txn_pct

  const items = [
    feeText,
    fx === undefined ? "" : fx === 0 ? "No overseas fee" : `${pct(fx)} overseas`,
    card.rates.purchase === undefined ? "" : `${pct(card.rates.purchase)} p.a.`,
    program === undefined ? "No rewards" : program.name,
    v.firstYearBonusPoints === undefined ? "" : `${compactPoints(v.firstYearBonusPoints)} bonus pts`
  ]

  return EffectArray.join(
    EffectArray.flatMap(items, (t) => (t === "" ? [] : [`<li>${esc(t)}</li>`])),
    ""
  )
}

const ledger = (r: Ranked, scale: number) => {
  const v = r.valuation
  const earn = v.earnValue ?? 0
  const bonus = goalOf() === "bonus" ? (v.firstYearBonusValue ?? 0) : 0
  const fee = (goalOf() === "bonus" ? v.firstYearFee : v.fee) ?? 0

  if (scale <= 0 || (earn === 0 && bonus === 0 && fee === 0)) return ""
  const width = (n: number) => `${Math.max(0, Math.min(100, (n / scale) * 100)).toFixed(1)}%`

  const label = EffectArray.join(
    EffectArray.filter(
      [
        earn > 0 ? `${money(Math.round(earn))} in points` : "",
        bonus > 0 ? `${money(Math.round(bonus))} bonus` : "",
        fee > 0 ? `${money(fee)} fee` : ""
      ],
      (t) => t !== ""
    ),
    ", "
  )

  return `<span class="ledger" role="img" aria-label="${esc(label)}">
    <span class="half cost"><span class="bar-fee" style="width:${width(fee)}"></span></span>
    <span class="half gain"><span class="bar-earn" style="width:${width(earn)}"></span><span class="bar-bonus" style="width:${width(bonus)}"></span></span>
  </span>`
}

const ledgerScale = (rows: ReadonlyArray<Ranked>) =>
  Math.max(
    1,
    ...EffectArray.flatMap(rows.slice(0, 60), (r) => [
      (r.valuation.earnValue ?? 0) + (goalOf() === "bonus" ? (r.valuation.firstYearBonusValue ?? 0) : 0),
      r.valuation.fee ?? 0
    ])
  )

const isCompared = (id: string) => state.compare.includes(id)

const listItem = (r: Ranked, index: number, scale: number) => {
  const { entry } = r
  const h = headline(r)
  const compared = isCompared(entry.id)
  const delay = Math.min(index, MOTION.listStaggerCap) * MOTION.listStaggerMs
  const transitionName = index < 40 ? `view-transition-name: c${entries.indexOf(entry)};` : ""

  return `<li class="item" style="${transitionName}--delay:${delay}ms">
    <span class="rank" aria-hidden="true">${index + 1}</span>
    <button type="button" class="open" data-open="${esc(entry.id)}" aria-label="${esc(`${entry.card.name}, ${h.figure} ${h.caption}`)}">
      ${art(entry, "m")}
      <span class="who">
        <span class="name">${esc(entry.card.name)}</span>
        <span class="issuer">${esc(entry.issuer)}</span>
      </span>
    </button>
    <span class="figure tone-${h.tone}">
      <b>${esc(h.figure)}</b>
      <small>${esc(h.caption)}</small>
    </span>
    <ul class="facts">${facts(r)}</ul>
    ${ledger(r, scale)}
    <button type="button" class="pin${compared ? " on" : ""}" data-pin="${esc(entry.id)}" aria-pressed="${compared}">
      <span aria-hidden="true">${compared ? "✓" : "+"}</span> Compare
    </button>
  </li>`
}

const segmented = <T extends string>(
  id: string,
  options: ReadonlyArray<{ readonly id: T; readonly label: string }>,
  current: T
) => {
  $(id).innerHTML = EffectArray.join(
    EffectArray.map(
      options,
      (o) =>
        `<button type="button" role="radio" data-value="${o.id}" aria-checked="${o.id === current}">${esc(o.label)}</button>`
    ),
    ""
  )
}

const renderControls = () => {
  $("goals").innerHTML = EffectArray.join(
    EffectArray.map(
      goalIds,
      (id) =>
        `<button type="button" role="radio" data-value="${id}" aria-checked="${id === goalOf()}">${esc(goals[id].label)}</button>`
    ),
    ""
  )
  $("goal-sentence").textContent = goals[goalOf()].sentence
  segmented("type", typeOptions, state.type)
  segmented("kind", kindOptions, state.kind)
  segmented("view", viewOptions, state.view)
}

const spendInput = element("spend", HTMLInputElement)
const spendRange = element("spend-range", HTMLInputElement)

const nearestStop = (spend: number) =>
  EffectArray.reduce(SPEND_STOPS, 0, (best, stop, i) =>
    Math.abs(stop - spend) < Math.abs(required(SPEND_STOPS[best]) - spend) ? i : best
  )

const syncSpend = (fromRange: boolean) => {
  if (!fromRange) spendRange.value = String(nearestStop(state.spend))

  if (document.activeElement !== spendInput) spendInput.value = whole(state.spend)
  spendInput.style.setProperty("--chars", String(Math.max(3, whole(state.spend).length)))
  spendRange.style.setProperty("--fill", `${(Number(spendRange.value) / (SPEND_STOPS.length - 1)) * 100}%`)
}

const summary = (rows: ReadonlyArray<Ranked>) => {
  const all = EffectArray.filter(entries, (e) => e.card.status === "active").length
  const goal = goals[goalOf()]

  if (rows.length === 0) return `No cards match. Try fewer filters.`

  return `${rows.length} of ${all} cards, ranked for ${goal.sentence} at ${money(state.spend)} a month.`
}

let lastRows: ReadonlyArray<Ranked> = []

const renderList = (rows: ReadonlyArray<Ranked>) => {
  const scale = ledgerScale(rows)

  $("list").innerHTML = EffectArray.join(
    EffectArray.map(rows, (r, i) => listItem(r, i, scale)),
    ""
  )
}

interface Point {
  readonly r: Ranked
  readonly x: number
  readonly y: number
  readonly rank: number
}

const niceStep = (span: number, count: number) => {
  const raw = span / Math.max(1, count)
  const power = 10 ** Math.floor(Math.log10(raw))

  return (Option.getOrUndefined(EffectArray.findFirst([1, 2, 2.5, 5, 10], (m) => m * power >= raw)) ?? 10) * power
}

const ticks = (min: number, max: number, count: number) => {
  const step = niceStep(max - min, count)
  const start = Math.floor(min / step) * step

  return Array.from(
    { length: Math.round((Math.ceil(max / step) * step - start) / step) + 1 },
    (_, i) => start + i * step
  )
}

let points: ReadonlyArray<Point> = []

const plotted = (r: Ranked) => (goalOf() === "bonus" ? r.valuation.firstYear : r.valuation.ongoing)

interface Placed {
  readonly p: Point
  readonly y: number
}

const LABEL_GAP = 16

const stackLabels = (labelled: ReadonlyArray<Point>) => {
  const placed: Array<Placed> = []

  for (const p of EffectArray.sortWith(labelled, (point) => point.y, Order.Number)) {
    placed.push({ p, y: Math.max(p.y, (placed.at(-1)?.y ?? -Infinity) + LABEL_GAP) })
  }

  return placed
}

const plottable = (r: Ranked, position: number): ReadonlyArray<Point> => {
  const y = plotted(r)
  const x = goalOf() === "bonus" ? r.valuation.firstYearFee : r.valuation.fee

  return y === undefined || x === undefined ? [] : [{ r, x, y, rank: position }]
}

const renderMap = (rows: ReadonlyArray<Ranked>) => {
  const host = $("plot")
  const width = Math.max(320, host.clientWidth)
  const height = Math.round(Math.min(560, Math.max(320, width * 0.6)))
  const pad = { top: 16, right: 20, bottom: 44, left: 64 }

  const usable = EffectArray.flatMap(rows, (r, position) => plottable(r, position))

  $("map-note").textContent =
    usable.length === rows.length
      ? `${usable.length} cards. Up and to the left is better.`
      : `${usable.length} of ${rows.length} cards plotted; the rest have no published earn rate or fee. Up and to the left is better.`

  if (usable.length === 0) {
    host.innerHTML = ""
    points = []

    return
  }

  const xTicks = ticks(0, Math.max(100, ...EffectArray.map(usable, (p) => p.x)), 6)

  const yTicks = ticks(
    Math.min(0, ...EffectArray.map(usable, (p) => p.y)),
    Math.max(0, ...EffectArray.map(usable, (p) => p.y)),
    6
  )

  const xMax = required(xTicks.at(-1))
  const yMin = required(yTicks[0])
  const yMax = required(yTicks.at(-1))
  const sx = (x: number) => pad.left + (x / xMax) * (width - pad.left - pad.right)
  const sy = (y: number) => pad.top + ((yMax - y) / (yMax - yMin || 1)) * (height - pad.top - pad.bottom)

  points = EffectArray.map(usable, (p) => ({ r: p.r, rank: p.rank, x: sx(p.x), y: sy(p.y) }))

  const grid = EffectArray.join(
    EffectArray.map(
      yTicks,
      (t) =>
        `<line class="${t === 0 ? "zero" : "grid"}" x1="${pad.left}" x2="${width - pad.right}" y1="${sy(t)}" y2="${sy(t)}" />
        <text class="tick" x="${pad.left - 10}" y="${sy(t)}" text-anchor="end" dominant-baseline="middle">${t === 0 ? "$0" : signed(t)}</text>`
    ),
    ""
  )

  const xAxis = EffectArray.join(
    EffectArray.map(
      xTicks,
      (t) => `<text class="tick" x="${sx(t)}" y="${height - pad.bottom + 18}" text-anchor="middle">${money(t)}</text>`
    ),
    ""
  )

  const labelled = new Set(EffectArray.map(points.slice(0, 5), (p) => p.r.entry.id))

  const dot = (p: Point) => {
    const id = p.r.entry.id
    const cls = EffectArray.join([labelled.has(id) ? "top" : "", isCompared(id) ? "pinned" : ""], " ")

    return `<circle class="dot ${cls}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.5" />`
  }

  const label = (placed: Placed) => {
    const { p, y } = placed
    const right = p.x < width * 0.7
    const x = p.x + (right ? 10 : -10)
    const leader = Math.abs(y - p.y) < 1 ? "" : `<line class="leader" x1="${p.x}" y1="${p.y}" x2="${x}" y2="${y}" />`

    return `${leader}<text class="label" x="${x + (right ? 2 : -2)}" y="${y}" text-anchor="${right ? "start" : "end"}" dominant-baseline="middle">${p.rank + 1}. ${esc(p.r.entry.card.name)}</text>`
  }

  const dots = EffectArray.join(
    EffectArray.map(EffectArray.reverse(points), (p) => dot(p)),
    ""
  )

  const labels = EffectArray.join(
    EffectArray.map(stackLabels(EffectArray.filter(points, (p) => labelled.has(p.r.entry.id))), (p) => label(p)),
    ""
  )

  const yTitle = goalOf() === "bonus" ? "Back in year one, after fees" : "Back each year, after the fee"

  host.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img"
    aria-label="Scatter plot of ${points.length} cards: annual fee against ${esc(EffectString.toLowerCase(yTitle))}. The ranked list has the same data.">
    ${grid}
    ${xAxis}
    <text class="axis" x="${pad.left}" y="${height - 6}">Annual fee →</text>
    <text class="axis" x="${pad.left + 8}" y="${pad.top + 4}" dominant-baseline="hanging">↑ ${esc(yTitle)}</text>
    <circle class="hover-ring" r="9" cx="0" cy="0" visibility="hidden" />
    ${dots}
    ${labels}
  </svg>`
}

const render = () => {
  const rows = visibleRows()
  lastRows = rows
  renderControls()
  syncSpend(document.activeElement === spendRange)
  $("summary").textContent = summary(rows)
  $("list").hidden = state.view !== "list"
  $("map").hidden = state.view !== "map"

  if (state.view === "list") renderList(rows)
  else renderMap(rows)
  renderTray()
  writeHash()
}

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)")

const transition = (update: () => void) => {
  if ("startViewTransition" in document && !reduceMotion.matches && state.view === "list") {
    document.startViewTransition(update)
  } else {
    update()
  }
}

const introTargets = {
  purchase: "purchases",
  balance_transfer: "balance transfers",
  both: "purchases and balance transfers"
}

const forMonths = (months: number | undefined) => (months === undefined ? "" : ` for ${months} months`)

const signupText = (c: SignupPoints) => {
  const conditions = EffectArray.filter(
    [
      c.min_spend === undefined
        ? ""
        : `spend ${money(c.min_spend)}${c.spend_days === undefined ? "" : ` in ${c.spend_days} days`}`,
      c.keep_months === undefined ? "" : `keep the card ${c.keep_months} months`
    ],
    (t) => t !== ""
  )

  return `${whole(c.points)} bonus points${c.year === undefined ? "" : ` in year ${c.year}`}${
    conditions.length === 0 ? "" : ` when you ${EffectArray.join(conditions, " and ")}`
  }`
}

const offerComponent = (c: OfferComponent) => {
  if (c.kind === "intro_rate") return `${pct(c.rate)} on ${introTargets[c.applies_to]}${forMonths(c.months)}`

  if (c.kind === "fee_discount") {
    return `${c.fee === "annual" ? "Annual fee" : c.fee} of ${money(c.payable)}${forMonths(c.months)}`
  }

  if (c.kind === "signup_points") return signupText(c)

  return `${money(c.amount)} back${c.conditions === undefined ? "" : ` (${c.conditions})`}`
}

const formatDate = (iso: string) =>
  Option.match(DateTime.make(`${pipe(iso, EffectString.slice(0, 10))}T00:00:00Z`), {
    onNone: () => iso,
    onSome: (date) =>
      DateTime.format(date, { locale: "en-AU", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
  })

const offerBlock = (o: Offer) => {
  const meta = EffectArray.filter(
    [
      o.valid_until === undefined ? "" : `Ends ${formatDate(o.valid_until)}`,
      o.eligibility ?? "",
      o.application_channel ?? "",
      o.conditions ?? ""
    ],
    (t) => t !== ""
  )

  return `<li><ul class="offer">${EffectArray.join(
    EffectArray.map(o.components, (c) => `<li>${esc(offerComponent(c))}</li>`),
    ""
  )}</ul>${
    meta.length === 0
      ? ""
      : `<p class="dim">${EffectArray.join(
          EffectArray.map(meta, (t) => esc(t)),
          " · "
        )}</p>`
  }</li>`
}

const earnLines = (e: Entry) => {
  const earn = e.card.rewards?.earn ?? []
  let previousCap: number | undefined

  const line = (tier: (typeof earn)[number]) => {
    const base = isBaseRate(tier.category)

    const where = !base
      ? `on ${tier.category ?? ""}`
      : tier.cap_monthly === undefined
        ? previousCap === undefined
          ? "on everyday spend"
          : "after that"
        : `up to ${money(tier.cap_monthly)} a month`

    if (base && tier.cap_monthly !== undefined) previousCap = tier.cap_monthly

    return `<li><b>${tier.rate}</b> <span>pts per $1 ${esc(where)}${tier.note === undefined ? "" : ` <span class="dim">(${esc(tier.note)})</span>`}</span></li>`
  }

  return EffectArray.map(earn, (tier) => line(tier))
}

const row = (label: string, text: string | undefined) =>
  text === undefined ? "" : `<div><dt>${esc(label)}</dt><dd>${esc(text)}</dd></div>`

const opt = <T>(n: T | undefined, format: (n: T) => string) => (n === undefined ? undefined : format(n))

const breakdown = (r: Ranked) => {
  const v = r.valuation
  const program = r.entry.program

  const lines = [
    program === undefined
      ? `<div><dt>Rewards</dt><dd>None</dd></div>`
      : v.yearlyPoints === undefined
        ? `<div><dt>Points</dt><dd class="dim">Earn rate not published</dd></div>`
        : `<div><dt>${whole(v.yearlyPoints)} ${esc(program.name)} points${
            v.centsPerPoint === undefined ? "" : ` × ${v.centsPerPoint}¢`
          }</dt><dd class="tone-up">${v.earnValue === undefined ? "?" : signed(v.earnValue)}</dd></div>`,
    v.fee === undefined
      ? `<div><dt>Annual fee</dt><dd class="dim">Not published</dd></div>`
      : `<div><dt>Annual fee</dt><dd class="tone-down">${v.fee === 0 ? "$0" : signed(-v.fee)}</dd></div>`,
    `<div class="total"><dt>Each year</dt><dd>${v.ongoing === undefined ? "?" : signed(v.ongoing)}</dd></div>`
  ]

  const bonusText =
    v.firstYearBonusPoints === undefined
      ? ""
      : v.bonusMissed
        ? `, without the ${whole(v.firstYearBonusPoints)} bonus points (spend target not met)`
        : `, with ${whole(v.firstYearBonusPoints)} bonus points`

  const feeText = v.firstYearFee !== undefined && v.firstYearFee !== v.fee ? ` and a ${money(v.firstYearFee)} fee` : ""

  const yearOne =
    v.firstYearBonusPoints === undefined && v.firstYearFee === v.fee
      ? ""
      : `<div class="total"><dt>Year one${bonusText}${feeText}</dt><dd>${
          v.firstYear === undefined ? "?" : signed(v.firstYear)
        }</dd></div>`

  return `<dl class="breakdown">${EffectArray.join(lines, "")}${yearOne}</dl>`
}

const typeNames = { personal: "Personal", business: "Business", corporate: "Corporate" }

const renderSheet = (id: string) => {
  const entry = entryById.get(id)

  if (entry === undefined) return false
  const r = { entry, valuation: value(entry, state.spend, overrides, today) }
  const { card } = entry
  const offers = currentOffers(card, today)
  const earn = earnLines(entry)

  const rank = Option.getOrElse(
    EffectArray.findFirstIndex(lastRows, (x) => x.entry.id === id),
    () => -1
  )

  const compared = isCompared(id)
  const updated = card.cdr?.last_updated

  const chips = EffectArray.filter(
    [
      typeNames[card.type],
      card.network === undefined ? "" : networkNames[card.network],
      card.perks.lounge_access === true ? "Lounge access" : "",
      rank < 0 ? "" : `#${rank + 1} for ${EffectString.toLowerCase(goals[goalOf()].label)}`
    ],
    (t) => t !== ""
  )

  $("sheet-body").innerHTML = `
    <header class="sheet-head">
      <span class="eyebrow">${esc(entry.issuer)}</span>
      <button type="button" class="close" data-close aria-label="Close">×</button>
    </header>
    <div class="hero">
      ${art(entry, "l")}
      <div>
        <h2 id="sheet-title">${esc(card.name)}</h2>
        <ul class="chips">${EffectArray.join(
          EffectArray.map(chips, (c) => `<li>${esc(c)}</li>`),
          ""
        )}</ul>
        <div class="actions">
          ${card.url === undefined ? "" : `<a class="primary" href="${esc(card.url)}" target="_blank" rel="noopener">See it on ${esc(entry.issuer)} ↗</a>`}
          <button type="button" class="ghost pin${compared ? " on" : ""}" data-pin="${esc(id)}" aria-pressed="${compared}">${compared ? "✓ Comparing" : "+ Compare"}</button>
        </div>
      </div>
    </div>
    ${card.description === undefined ? "" : `<p class="lede">${esc(card.description)}</p>`}
    <section>
      <h3>At ${money(state.spend)} a month</h3>
      ${breakdown(r)}
    </section>
    ${earn.length === 0 ? "" : `<section><h3>How it earns</h3><ul class="earn">${EffectArray.join(earn, "")}</ul></section>`}
    ${
      offers.length === 0
        ? ""
        : `<section><h3>Current offers</h3><ul class="offers">${EffectArray.join(
            EffectArray.map(offers, (o) => offerBlock(o)),
            ""
          )}</ul></section>`
    }
    <section class="specs">
      <div>
        <h3>Fees</h3>
        <dl>
          ${row("Annual", opt(card.fees.annual, money))}
          ${row("Additional card", opt(card.fees.additional_card, money))}
          ${row("Overseas purchases", opt(card.fees.foreign_txn_pct, pct))}
          ${row("Cash advance", opt(card.fees.cash_advance_pct, pct))}
          ${row("Late payment", opt(card.fees.late_payment, money))}
        </dl>
      </div>
      <div>
        <h3>Interest</h3>
        <dl>
          ${row(
            "Purchases",
            opt(card.rates.purchase, (n) => `${pct(n)} p.a.`)
          )}
          ${row(
            "Cash advances",
            opt(card.rates.cash_advance, (n) => `${pct(n)} p.a.`)
          )}
          ${row(
            "Balance transfers",
            opt(card.rates.balance_transfer, (n) => `${pct(n)} p.a.`)
          )}
          ${row(
            "Interest-free days",
            opt(card.rates.interest_free_days, (n) => `Up to ${n}`)
          )}
        </dl>
      </div>
      <div>
        <h3>Limits</h3>
        <dl>
          ${row("Minimum credit", opt(card.limits.min_credit, money))}
          ${row("Maximum credit", opt(card.limits.max_credit, money))}
          ${row("Minimum income", opt(card.limits.min_income, money))}
        </dl>
      </div>
    </section>
    ${
      (card.perks.insurance ?? []).length === 0
        ? ""
        : `<section><h3>Insurance</h3><ul class="chips">${EffectArray.join(
            EffectArray.map(card.perks.insurance ?? [], (i) => `<li>${esc(i)}</li>`),
            ""
          )}</ul></section>`
    }
    <p class="source dim">From ${esc(card.cdr?.brand ?? entry.issuer)}'s Consumer Data Right product data${
      updated === undefined ? "" : `, updated ${formatDate(updated)}`
    }.${card.rewards?.earn_source === undefined ? "" : ` Earn rates ${card.rewards.earn_source === "manual" ? "reviewed by hand" : "read by the parser"}.`}
    <a href="https://github.com/southerly-labs/creditcards/issues/new?template=data-correction.yml&title=${encodeURIComponent(`Correction: ${id}`)}" target="_blank" rel="noopener">Report a mistake</a></p>
  `

  return true
}

const sheet = element("sheet", HTMLDialogElement)

const dialogElements = (): ReadonlyArray<readonly [DialogName, HTMLDialogElement]> => [
  ["sheet", sheet],
  ["compare", element("compare", HTMLDialogElement)],
  ["values", element("values", HTMLDialogElement)]
]

const sendDialog = (event: DialogEvent) => {
  openUi = Effect.runSync(stepDialog(openUi, event))
  const open = openDialog(openUi)

  for (const [name, el] of dialogElements()) if (name !== open && el.open) el.close()

  for (const [name, el] of dialogElements()) if (name === open && !el.open) el.showModal()
  const card = DialogState.guards.Sheet(openUi) ? openUi.card : ""

  if (card !== state.card) {
    state.card = card
    writeHash()
  }
}

const openSheet = (id: string) => {
  if (!renderSheet(id)) return
  sendDialog(DialogEvent.cases.OpenCard.make({ card: id }))
  sheet.scrollTop = 0
}

for (const [name, el] of dialogElements())
  el.addEventListener("close", () => {
    sendDialog(DialogEvent.cases.Closed.make({ dialog: name }))
  })

interface CompareRow {
  readonly label: string
  readonly read: (r: Ranked) => number | undefined
  readonly show: (n: number) => string
  readonly better: "high" | "low"
}

const compareRows: ReadonlyArray<CompareRow> = [
  { label: "Back each year", read: (r) => r.valuation.ongoing, show: signed, better: "high" },
  { label: "Back in year one", read: (r) => r.valuation.firstYear, show: signed, better: "high" },
  { label: "Annual fee", read: (r) => r.valuation.fee, show: money, better: "low" },
  { label: "Year one fee", read: (r) => r.valuation.firstYearFee, show: money, better: "low" },
  { label: "Points a year", read: (r) => r.valuation.yearlyPoints, show: whole, better: "high" },
  { label: "Base earn per $1", read: (r) => baseEarnRate(r.entry.card), show: (n) => `${n} pts`, better: "high" },
  { label: "Bonus points", read: (r) => r.valuation.bonusPoints, show: whole, better: "high" },
  { label: "Overseas fee", read: (r) => r.entry.card.fees.foreign_txn_pct, show: pct, better: "low" },
  { label: "Purchase rate", read: (r) => r.entry.card.rates.purchase, show: pct, better: "low" },
  { label: "Cash advance rate", read: (r) => r.entry.card.rates.cash_advance, show: pct, better: "low" },
  { label: "Interest-free days", read: (r) => r.entry.card.rates.interest_free_days, show: whole, better: "high" },
  { label: "Minimum credit", read: (r) => r.entry.card.limits.min_credit, show: money, better: "low" },
  { label: "Minimum income", read: (r) => r.entry.card.limits.min_income, show: money, better: "low" }
]

const comparedRow = (id: string): ReadonlyArray<Ranked> => {
  const entry = entryById.get(id)

  return entry === undefined ? [] : [{ entry, valuation: value(entry, state.spend, overrides, today) }]
}

const compareLine = (c: CompareRow, rows: ReadonlyArray<Ranked>) => {
  const values = EffectArray.map(rows, (r) => c.read(r))
  const known = EffectArray.filter(values, (n) => n !== undefined)
  const best = known.length < 2 ? undefined : c.better === "high" ? Math.max(...known) : Math.min(...known)
  const distinct = new Set(known).size > 1

  const cell = (n: number | undefined) =>
    n === undefined
      ? `<td class="dim">—</td>`
      : `<td class="${distinct && n === best ? "best" : ""}">${esc(c.show(n))}</td>`

  return `<tr><th scope="row">${esc(c.label)}</th>${EffectArray.join(
    EffectArray.map(values, (n) => cell(n)),
    ""
  )}</tr>`
}

const renderCompare = () => {
  const rows = EffectArray.flatMap(state.compare, (id) => comparedRow(id))

  const bodyRows = EffectArray.join(
    EffectArray.map(compareRows, (c) => compareLine(c, rows)),
    ""
  )

  $("compare-body").innerHTML = `
    <header class="sheet-head">
      <h2 id="compare-title">Side by side at ${money(state.spend)} a month</h2>
      <button type="button" class="close" data-close aria-label="Close">×</button>
    </header>
    <div class="compare-scroll">
      <table class="compare-table">
        <thead><tr><td></td>${EffectArray.join(
          EffectArray.map(
            rows,
            (r) =>
              `<th scope="col"><button type="button" class="open" data-open="${esc(r.entry.id)}">${art(r.entry, "s")}<span class="name">${esc(r.entry.card.name)}</span><span class="issuer">${esc(r.entry.issuer)}</span></button>
              <button type="button" class="link" data-pin="${esc(r.entry.id)}">Remove</button></th>`
          ),
          ""
        )}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
    <p class="dim">The best value in each row is marked.</p>`
}

const trayCard = (id: string) => {
  const e = entryById.get(id)

  if (e === undefined) return []

  return [
    `<li><button type="button" data-pin="${esc(id)}" aria-label="${esc(`Remove ${e.card.name}`)}" title="${esc(e.card.name)}">${art(e, "s")}</button></li>`
  ]
}

const renderTray = () => {
  const tray = $("tray")
  tray.hidden = state.compare.length === 0
  document.body.classList.toggle("has-tray", state.compare.length > 0)

  $("tray-cards").innerHTML = EffectArray.join(
    EffectArray.flatMap(state.compare, (id) => trayCard(id)),
    ""
  )

  const button = element("open-compare", HTMLButtonElement)
  button.disabled = !TrayState.guards.Ready(compareTray)
  button.textContent = TrayState.guards.Ready(compareTray) ? `Compare ${compareTray.ids.length}` : "Pick one more"
}

const togglePin = (id: string) => {
  sendTray(TrayEvent.cases.Toggle.make({ id, limit: COMPARE_LIMIT }))
  render()

  if (DialogState.guards.Sheet(openUi)) renderSheet(openUi.card)

  if (TrayState.guards.Empty(compareTray)) sendDialog(DialogEvent.cases.TrayEmptied.make({}))
  else if (DialogState.guards.Comparing(openUi)) renderCompare()
}

const renderValueGrid = () => {
  const counts = new Map<string, number>()

  for (const e of entries) if (e.program !== undefined) counts.set(e.program.id, (counts.get(e.program.id) ?? 0) + 1)

  const programs = EffectArray.sort(
    EffectArray.map([...counts.keys()], (id) => ({ id, program: required(api.programs[id]) })),
    Order.combineAll<{ readonly id: string; readonly program: Api["programs"][string] }>([
      Order.mapInput(Order.Boolean, (p) => p.program.type !== "airline"),
      Order.mapInput(Order.flip(Order.Number), (p) => required(counts.get(p.id))),
      Order.make((a, b) => pipe(a.program.name, EffectString.localeCompare(b.program.name)))
    ])
  )

  $("value-grid").innerHTML = `<ul class="values">${EffectArray.join(
    EffectArray.map(
      programs,
      ({ id, program }) => `<li>
        <label for="pv-${esc(id)}">${esc(program.name)}<small>${required(counts.get(id))} card${counts.get(id) === 1 ? "" : "s"}${
          program.value_basis === undefined ? "" : ` · ${esc(program.value_basis)}`
        }</small></label>
        <span class="cents"><input id="pv-${esc(id)}" type="number" min="0" max="10" step="0.05" inputmode="decimal"
          data-program="${esc(id)}" placeholder="${program.cents_per_point ?? "?"}" value="${overrides[id] ?? ""}" />¢</span>
      </li>`
    ),
    ""
  )}</ul>`
}

const tip = $("tip")

const showTip = (p: Point, host: DOMRect) => {
  const v = p.r.valuation
  const y = plotted(p.r)
  tip.replaceChildren()
  const strong = document.createElement("strong")
  strong.textContent = y === undefined ? "?" : signed(y)
  const name = document.createElement("span")
  name.textContent = `${p.rank + 1}. ${p.r.entry.card.name}`
  const detail = document.createElement("small")
  detail.textContent = `${p.r.entry.issuer} · ${v.fee === undefined ? "fee unknown" : `${money(v.fee)} fee`}`
  tip.append(strong, name, detail)
  tip.hidden = false
  const left = Math.min(host.left + p.x + 14, innerWidth - tip.offsetWidth - 8)
  tip.style.transform = `translate(${left}px, ${host.top + p.y - tip.offsetHeight / 2}px)`
}

const HIT_RADIUS = 24

const nearest = (x: number, y: number) => {
  const distance = (p: Point) => Math.hypot(p.x - x, p.y - y)

  return pipe(
    EffectArray.filter(points, (p) => distance(p) < HIT_RADIUS),
    EffectArray.sortWith(distance, Order.Number),
    EffectArray.head,
    Option.getOrUndefined
  )
}

const plotPoint = (e: MouseEvent) => {
  const svg = $("plot").querySelector("svg")

  if (svg === null) return undefined
  const box = svg.getBoundingClientRect()

  return { box, point: nearest(e.clientX - box.left, e.clientY - box.top) }
}

const hoverPlot = (e: PointerEvent) => {
  const hit = plotPoint(e)
  const ring = $("plot").querySelector(".hover-ring")

  if (hit?.point === undefined) {
    tip.hidden = true
    ring?.setAttribute("visibility", "hidden")

    return
  }

  ring?.setAttribute("cx", String(hit.point.x))
  ring?.setAttribute("cy", String(hit.point.y))
  ring?.setAttribute("visibility", "visible")
  $("plot").style.cursor = "pointer"
  showTip(hit.point, hit.box)
}

$("plot").addEventListener("pointermove", hoverPlot)

$("plot").addEventListener("pointerleave", () => {
  tip.hidden = true
  $("plot").style.cursor = ""
})

$("plot").addEventListener("click", (e) => {
  const hit = plotPoint(e)

  if (hit?.point !== undefined) openSheet(hit.point.r.entry.id)
})

new ResizeObserver(() => {
  if (state.view === "map") renderMap(lastRows)
}).observe($("map"))

const radioValue = (e: Event) => {
  const button = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>("[role=radio]") : null

  return button?.dataset["value"] ?? null
}

$("goals").addEventListener("click", (e) => {
  const goal = radioValue(e)

  if (isGoalId(goal) && goal !== state.goal) {
    state.goal = goal
    transition(render)
  }
})

const onSegment = (id: string, apply: (v: string) => void) => {
  const choose = (e: MouseEvent) => {
    const v = radioValue(e)

    if (v === null) return
    apply(v)
    transition(render)
  }

  $(id).addEventListener("click", choose)
}

onSegment("type", (v) => {
  state.type = oneOf<TypeId>(typeOptions, v, state.type)
})

onSegment("kind", (v) => {
  state.kind = oneOf<KindId>(kindOptions, v, state.kind)
})

onSegment("view", (v) => {
  state.view = oneOf<ViewId>(viewOptions, v, state.view)
})

const arrowKeys = (group: string) => (e: KeyboardEvent) => {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return
  const buttons = [...$(group).querySelectorAll<HTMLElement>("[role=radio]")]

  const at = Option.getOrElse(
    EffectArray.findFirstIndex(buttons, (b) => b.getAttribute("aria-checked") === "true"),
    () => -1
  )

  const step = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1
  const next = buttons[(at + step + buttons.length) % buttons.length]
  e.preventDefault()
  next?.click()
  $(group).querySelector<HTMLElement>("[aria-checked=true]")?.focus()
}

for (const group of ["goals", "type", "kind", "view"]) $(group).addEventListener("keydown", arrowKeys(group))

const store = (key: string, text: string) =>
  attempt(() => {
    localStorage.setItem(key, text)
  })

const setSpend = (spend: number, fromRange: boolean) => {
  state.spend = spend
  store(SPEND_KEY, String(spend))

  lastRows = visibleRows()
  syncSpend(fromRange)
  $("summary").textContent = summary(lastRows)

  if (state.view === "list") renderList(lastRows)
  else renderMap(lastRows)
  writeHash()
}

spendRange.max = String(SPEND_STOPS.length - 1)

spendRange.addEventListener("input", () => {
  setSpend(required(SPEND_STOPS[Number(spendRange.value)]), true)
})

spendInput.addEventListener("input", () => {
  const spend = decodeMonthlySpend(pipe(spendInput.value, EffectString.replaceAll(/[$,\s]/gu, "")))

  if (spend !== undefined) setSpend(spend, false)
})

spendInput.addEventListener("blur", () => {
  spendInput.value = whole(state.spend)
})

spendInput.addEventListener("focus", () => {
  spendInput.select()
})

const search = element("search", HTMLInputElement)

search.value = state.query

search.addEventListener("input", () => {
  state.query = search.value
  render()
})

document.addEventListener("keydown", (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement

  if (e.key === "/" && !typing && DialogState.guards.Browsing(openUi)) {
    e.preventDefault()
    search.focus()
  }
})

const clickAnywhere = (e: MouseEvent) => {
  const target = e.target instanceof Element ? e.target : null
  const pin = target?.closest<HTMLElement>("[data-pin]")
  const open = target?.closest<HTMLElement>("[data-open]")

  if (pin != null) {
    togglePin(pin.dataset["pin"] ?? "")

    return
  }

  if (open != null) {
    openSheet(open.dataset["open"] ?? "")

    return
  }

  if (target?.closest("[data-close]") !== null) target?.closest("dialog")?.close()
}

document.addEventListener("click", clickAnywhere)

for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close()
  })
}

document.addEventListener(
  "error",
  (e) => {
    if (e.target instanceof HTMLImageElement && e.target.parentElement?.classList.contains("art") === true)
      e.target.remove()
  },
  true
)

element("open-compare", HTMLButtonElement).addEventListener("click", () => {
  renderCompare()
  sendDialog(DialogEvent.cases.OpenCompare.make({}))
})

element("clear-compare", HTMLButtonElement).addEventListener("click", () => {
  sendTray(TrayEvent.cases.Clear.make({}))
  render()
  sendDialog(DialogEvent.cases.TrayEmptied.make({}))
})

element("open-values", HTMLButtonElement).addEventListener("click", () => {
  renderValueGrid()
  sendDialog(DialogEvent.cases.OpenValues.make({}))
})

const saveOverrides = () => store(OVERRIDES_KEY, Effect.runSync(encodeJson(overrides)))

const editPointValue = (e: Event) => {
  const input = e.target

  if (!(input instanceof HTMLInputElement)) return
  const id = input.dataset["program"] ?? ""
  const cents = EffectString.trim(input.value) === "" ? Number.NaN : Number(input.value)

  if (Number.isFinite(cents) && cents >= 0) overrides[id] = cents
  else delete overrides[id]
  saveOverrides()
  render()
}

$("value-grid").addEventListener("input", editPointValue)

element("value-reset", HTMLButtonElement).addEventListener("click", () => {
  for (const id of EffectRecord.keys(overrides)) delete overrides[id]
  saveOverrides()
  renderValueGrid()
  render()
})

const fresh = api.freshness.cdr_latest_product_updated_at

$("freshness").textContent =
  `${entries.length} cards from ${EffectRecord.keys(api.issuers).length} Australian lenders, read from their Consumer Data Right data${
    fresh === undefined ? "" : `. Latest product update ${formatDate(fresh)}`
  }.`

document.documentElement.style.setProperty("--sheet-ms", `${MOTION.sheetMs}ms`)

render()

if (state.card !== "") openSheet(state.card)
