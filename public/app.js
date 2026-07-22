/** Live API host (Render). When set, github.io uses real-time BoltOdds instead of static JSON. */
const LIVE_API_BASE = String(window.__MLB_API_BASE__ || "")
  .trim()
  .replace(/\/$/, "");

/** Base path for GitHub project Pages (/repo/) vs local server (/). */
const SITE_BASE = (() => {
  const parts = location.pathname.split("/").filter(Boolean);
  if (location.hostname.endsWith("github.io") && parts.length) {
    return `/${parts[0]}/`;
  }
  return "./";
})();

const STATIC_MODE =
  !LIVE_API_BASE &&
  (window.__MLB_STATIC__ === true ||
    document.documentElement.dataset.static === "true" ||
    location.hostname.endsWith("github.io"));

function apiUrl(path) {
  const clean = String(path || "").replace(/^\/+/, "").replace(/^api\//, "");
  if (LIVE_API_BASE) {
    return `${LIVE_API_BASE}/api/${clean}`;
  }
  if (STATIC_MODE) {
    return new URL(`api/${clean}.json`, new URL(SITE_BASE, location.origin)).href;
  }
  return `/api/${clean}`;
}

const elements = {
  loading: document.querySelector("#loadingState"),
  message: document.querySelector("#feedMessage"),
  lineCount: document.querySelector("#lineCount"),
  bookCount: document.querySelector("#bookCount"),
  arbCount: document.querySelector("#arbCount"),
  updatedAt: document.querySelector("#updatedAt"),
  status: document.querySelector("#headerStatus"),
  pulse: document.querySelector("#statusPulse"),
  refresh: document.querySelector("#refreshButton"),
  arbList: document.querySelector("#arbList"),
  arbEmpty: document.querySelector("#arbEmpty"),
  arbSummary: document.querySelector("#arbSummary"),
  gameChips: document.querySelector("#gameChips"),
  liveDetail: document.querySelector("#liveDetail"),
  liveEmpty: document.querySelector("#liveEmpty"),
  liveBoardSummary: document.querySelector("#liveBoardSummary"),
  liveScorecard: document.querySelector("#liveScorecard"),
  livePbpMeta: document.querySelector("#livePbpMeta"),
  liveBoardOdds: document.querySelector("#liveBoardOdds"),
  livePlays: document.querySelector("#livePlays"),
  liveStats: document.querySelector("#liveStats"),
  liveInjuries: document.querySelector("#liveInjuries"),
  prematchSummary: document.querySelector("#prematchSummary"),
  prematchMeta: document.querySelector("#prematchMeta"),
  prematchCards: document.querySelector("#prematchCards"),
  valueOddsBody: document.querySelector("#valueOddsBody"),
  valueEmpty: document.querySelector("#valueEmpty"),
  valueSummary: document.querySelector("#valueSummary"),
  valueSearch: document.querySelector("#valueSearch"),
  valueGroup: document.querySelector("#valueGroup"),
  valueMarket: document.querySelector("#valueMarket"),
  valueMinEv: document.querySelector("#valueMinEv"),
  valueTiming: document.querySelector("#valueTiming"),
  tabButtons: [...document.querySelectorAll(".app-tab")],
  panels: {
    live: document.querySelector("#panelLive"),
    prematch: document.querySelector("#panelPrematch"),
    value: document.querySelector("#panelValue"),
  },
};

const GAME_MARKETS = new Set(["Moneyline", "Spread", "Total"]);
const INNING_ORDINALS = ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th"];
const INNING_MARKETS = new Set(
  INNING_ORDINALS.flatMap((o) => [
    `${o} Inning Moneyline`,
    `${o} Inning Spread`,
    `${o} Inning Total`,
  ]),
);
const PROP_MARKETS = new Set([
  "Hits",
  "Home Runs",
  "RBIs",
  "Runs",
  "Bases",
  "Hits + Runs + RBIs",
  "Strikeouts Thrown",
  "Outs",
]);

const state = {
  tab: "live",
  odds: [],
  arbs: [],
  feeds: [],
  games: [],
  predictions: null,
  prematchRows: [],
  prematchSort: { key: "edge", dir: "desc" },
  selectedGameId: null,
  selectedEvent: null,
  expandedOdds: new Set(),
  lastPlayCountByGame: {},
  playDataframe: null,
  pbpFollowLatest: false,
  loading: false,
  queued: false,
  hasLoaded: false,
};

const FLASH_MS = 1400;
const previousSignatures = new Map();
const flashUntil = new Map();

function trackChanges(odds) {
  const seen = new Set();
  const now = Date.now();
  for (const odd of odds) {
    const quoteSignature = (odd.quotes || [])
      .map((quote) => `${quote.sportsbook?.id}:${quote.price}`)
      .join(",");
    const signature = `${odd.price}|${odd.sportsbook?.id}|${odd.fairPrice}|${quoteSignature}`;
    seen.add(odd.id);
    if (previousSignatures.has(odd.id) && previousSignatures.get(odd.id) !== signature) {
      flashUntil.set(odd.id, now + FLASH_MS);
    }
    previousSignatures.set(odd.id, signature);
  }
  for (const id of previousSignatures.keys()) {
    if (!seen.has(id)) {
      previousSignatures.delete(id);
      flashUntil.delete(id);
    }
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeLink(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function formatTime(value) {
  if (!value) return "Waiting for first update";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Just now";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatStart(value) {
  if (!value) return "Start time unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Start time unavailable";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

function formatAge(value) {
  if (!value) return "waiting";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function setOptions(select, values, placeholder) {
  const selected = select.value;
  select.innerHTML = [
    `<option value="">${escapeHtml(placeholder)}</option>`,
    ...values.map(
      ({ value, label }) =>
        `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`,
    ),
  ].join("");
  if (values.some(({ value }) => value === selected)) select.value = selected;
}

function marketGroup(odd) {
  const cat = odd.category || odd.market || "";
  if (GAME_MARKETS.has(cat)) return "game";
  if (INNING_MARKETS.has(cat)) return "inning";
  if (PROP_MARKETS.has(cat)) return "props";
  // Fallback: inning-ish names from feed
  if (/inning/i.test(cat)) return "inning";
  return "other";
}

function filterOdds({
  query = "",
  group = "",
  category = "",
  book = "",
  bestBook = "",
  minEv = null,
  timing = "",
  liveOnly = null,
  matchSelectedGame = false,
} = {}) {
  const q = query.trim().toLowerCase();
  return state.odds.filter((odd) => {
    const searchable = [odd.name, odd.market, odd.category, odd.event]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const offeredByBook =
      !book ||
      (odd.quotes || []).some((quote) => quote.sportsbook?.id === book);
    const matchesSelectedGame =
      !matchSelectedGame ||
      !state.selectedEvent ||
      odd.event === state.selectedEvent;
    const grp = marketGroup(odd);
    const timingOk =
      !timing ||
      (timing === "live" && odd.live) ||
      (timing === "pre" && !odd.live);
    const liveOk =
      liveOnly == null || Boolean(odd.live) === Boolean(liveOnly);
    const evOk = minEv == null || (Number.isFinite(odd.ev) && odd.ev >= minEv);
    return (
      (!q || searchable.includes(q)) &&
      (!group || grp === group) &&
      (!category || odd.category === category) &&
      offeredByBook &&
      (!bestBook || odd.sportsbook?.id === bestBook) &&
      evOk &&
      timingOk &&
      liveOk &&
      matchesSelectedGame
    );
  });
}

function currentValueOdds() {
  const minEv = Number(elements.valueMinEv?.value);
  return filterOdds({
    query: elements.valueSearch?.value || "",
    group: elements.valueGroup?.value || "",
    category: elements.valueMarket?.value || "",
    minEv: Number.isFinite(minEv) ? minEv : 0,
    timing: elements.valueTiming?.value || "",
  }).filter((odd) => marketGroup(odd) !== "inning");
}

/** @deprecated kept for any leftover callers — prefer tab-specific filters */
function currentOdds() {
  if (state.tab === "value") return currentValueOdds();
  return filterOdds({ matchSelectedGame: true });
}

function lineLabel(odd) {
  if (odd.line === null || odd.line === undefined) return odd.side || "ML";
  if (odd.side) return `${odd.side} ${odd.line}`.trim();
  return odd.line > 0 ? `+${odd.line}` : String(odd.line);
}

function widthLabel(odd) {
  const lineRange =
    Number.isFinite(odd.lineMin) && Number.isFinite(odd.lineMax)
      ? odd.lineMin === odd.lineMax
        ? `${odd.lineMin}`
        : `${odd.lineMin}–${odd.lineMax}`
      : "Matchup";
  return `${lineRange} · ${odd.bookCount} books`;
}

function quoteMarkup(quote) {
  const link = safeLink(quote.link);
  const content = `
    <span>${escapeHtml(quote.sportsbook?.name || quote.sportsbook?.id)}</span>
    <strong>${escapeHtml(quote.price)}</strong>
  `;
  return link
    ? `<a class="quote-chip" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">${content}</a>`
    : `<span class="quote-chip">${content}</span>`;
}

function legLineLabel(leg) {
  if (leg.side && Number.isFinite(leg.line)) return `${leg.side} ${leg.line}`;
  if (Number.isFinite(leg.line)) return leg.line > 0 ? `+${leg.line}` : String(leg.line);
  return "ML";
}

function renderArbs() {
  const arbs = (state.arbs || []).filter(
    (arb) => !/inning/i.test(String(arb.category || "")) && !/inning/i.test(String(arb.market || "")),
  );
  const plusEvCount = (state.odds || []).filter(
    (o) =>
      Number.isFinite(o.ev) &&
      o.ev >= 0.03 &&
      marketGroup(o) !== "inning",
  ).length;
  elements.arbCount.textContent = `${plusEvCount} / ${arbs.length}`;
  elements.arbEmpty.hidden = arbs.length > 0;
  elements.arbSummary.textContent = arbs.length
    ? `${arbs.length} two-way arb${arbs.length === 1 ? "" : "s"} · stakes sized for $100 total · game / props`
    : "No two-way arbs right now across game and prop markets.";

  elements.arbList.innerHTML = arbs
    .map((arb) => {
      const legs = (arb.legs || [])
        .map((leg) => {
          const link = safeLink(leg.link);
          const book = escapeHtml(leg.sportsbook?.name || leg.sportsbook?.id || "Book");
          const bookMarkup = link
            ? `<a class="book-pill best-book-link" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">${book}</a>`
            : `<span class="book-pill">${book}</span>`;
          return `
            <div class="arb-leg">
              <div class="arb-leg-copy">
                <strong>${escapeHtml(leg.name)}</strong>
                <span>${escapeHtml(legLineLabel(leg))} · ${escapeHtml(leg.price)} · ${bookMarkup}</span>
              </div>
              <div class="arb-leg-stake">
                $${Number(leg.stake).toFixed(2)}
                <em>pays $${Number(arb.payout).toFixed(2)}</em>
              </div>
            </div>
          `;
        })
        .join("");

      return `
        <article class="arb-card">
          <div class="arb-card-meta">
            <strong>${escapeHtml(arb.event)}</strong>
            <span>${escapeHtml(arb.live ? "LIVE" : formatStart(arb.startsAt))} · ${escapeHtml(arb.category)}${
              Number.isFinite(arb.line) ? ` ${escapeHtml(String(arb.line))}` : ""
            }</span>
          </div>
          <div class="arb-legs">${legs}</div>
          <div class="arb-profit">
            <strong>${formatPercent(arb.profit)}</strong>
            <span>on $100 · $${Number(arb.payout - arb.totalStake).toFixed(2)} profit</span>
          </div>
        </article>
      `;
    })
    .join("");
}

function setActiveTab(tab) {
  if (!elements.panels[tab]) return;
  state.tab = tab;
  for (const btn of elements.tabButtons) {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
  }
  for (const [key, panel] of Object.entries(elements.panels)) {
    if (!panel) continue;
    const active = key === tab;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  }
  if (tab === "prematch" && !state.predictions) loadPredictions();
  render();
}

function formatModelEv(ev) {
  if (ev == null || !Number.isFinite(Number(ev))) return "—";
  const pct = Number(ev) * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function prematchEdgeClass(edge) {
  const n = Number(edge);
  if (!Number.isFinite(n)) return "";
  if (n >= 0.03) return "positive";
  if (n <= -0.03) return "negative";
  return "";
}

function americanSortValue(price) {
  const n = Number(String(price ?? "").replace(/[+−]/g, (m) => (m === "−" ? "-" : "")));
  if (!Number.isFinite(n) || n === 0) return null;
  return n > 0 ? 100 / (n + 100) : Math.abs(n) / (Math.abs(n) + 100);
}

function lineSortValue(line) {
  const s = String(line ?? "").trim();
  if (!s || s === "—") return null;
  if (s === "ML") return 0;
  const n = Number(s.replace(/[+−]/g, (m) => (m === "−" ? "-" : "")));
  return Number.isFinite(n) ? n : null;
}

function projSortValue(proj) {
  const m = String(proj || "").match(/tot\s+([0-9.]+)/i);
  return m ? Number(m[1]) : null;
}

function comparePrematchRows(a, b, key, dir) {
  const mul = dir === "asc" ? 1 : -1;
  let av;
  let bv;
  switch (key) {
    case "edge":
      av = Number.isFinite(a.edge) ? a.edge : -Infinity;
      bv = Number.isFinite(b.edge) ? b.edge : -Infinity;
      break;
    case "fair":
      av = americanSortValue(a.fair) ?? -Infinity;
      bv = americanSortValue(b.fair) ?? -Infinity;
      break;
    case "bookPrice":
      av = americanSortValue(a.bookPrice) ?? -Infinity;
      bv = americanSortValue(b.bookPrice) ?? -Infinity;
      break;
    case "line":
      av = lineSortValue(a.line);
      bv = lineSortValue(b.line);
      if (av == null) av = -Infinity;
      if (bv == null) bv = -Infinity;
      break;
    case "proj":
      av = projSortValue(a.proj) ?? -Infinity;
      bv = projSortValue(b.proj) ?? -Infinity;
      break;
    case "matchup":
    case "market":
    case "selection":
    case "book":
      av = String(a[key] || "").toLowerCase();
      bv = String(b[key] || "").toLowerCase();
      return av < bv ? -1 * mul : av > bv ? 1 * mul : 0;
    default:
      av = a[key];
      bv = b[key];
  }
  if (av < bv) return -1 * mul;
  if (av > bv) return 1 * mul;
  return (
    String(a.matchup).localeCompare(String(b.matchup)) ||
    String(a.market).localeCompare(String(b.market)) ||
    String(a.selection).localeCompare(String(b.selection))
  );
}

function sortPrematchRows(rows) {
  const { key, dir } = state.prematchSort;
  return [...rows].sort((a, b) => comparePrematchRows(a, b, key, dir));
}

function prematchSortHeader(label, key) {
  const active = state.prematchSort.key === key;
  const arrow = !active ? "" : state.prematchSort.dir === "asc" ? " ↑" : " ↓";
  return `<th class="sortable-th${active ? " sorted" : ""}" data-sort-key="${escapeHtml(key)}" role="columnheader" tabindex="0">${escapeHtml(label)}${arrow}</th>`;
}

function buildPrematchRowData(data) {
  return (data.games || []).flatMap((g) => {
    const matchup = `${g.awayTeam} @ ${g.homeTeam}`;
    const proj = `${g.awayPredRuns ?? "—"}–${g.homePredRuns ?? "—"} (tot ${g.totalPredRuns ?? "—"})`;
    const pitchers = [
      g.awayPitcher
        ? `${g.awayPitcher}${g.awayPitcherEra != null ? ` ${g.awayPitcherEra}` : ""}`
        : null,
      g.homePitcher
        ? `${g.homePitcher}${g.homePitcherEra != null ? ` ${g.homePitcherEra}` : ""}`
        : null,
    ]
      .filter(Boolean)
      .join(" · ");

    const spreadAbs = g.spread?.line;
    const totalLine = g.total?.line;
    const awayFavored = Number(g.awayWinProb) >= Number(g.homeWinProb);
    const awaySpreadLine = Number.isFinite(Number(spreadAbs))
      ? `${awayFavored ? "-" : "+"}${Math.abs(Number(spreadAbs))}`
      : "—";
    const homeSpreadLine = Number.isFinite(Number(spreadAbs))
      ? `${awayFavored ? "+" : "-"}${Math.abs(Number(spreadAbs))}`
      : "—";

    return [
      { market: "Moneyline", selection: g.awayTeam, line: "ML", side: g.moneyline?.away },
      { market: "Moneyline", selection: g.homeTeam, line: "ML", side: g.moneyline?.home },
      { market: "Spread", selection: g.awayTeam, line: awaySpreadLine, side: g.spread?.away },
      { market: "Spread", selection: g.homeTeam, line: homeSpreadLine, side: g.spread?.home },
      {
        market: "Total",
        selection: "Over",
        line: totalLine != null ? String(totalLine) : "",
        side: g.total?.over,
      },
      {
        market: "Total",
        selection: "Under",
        line: totalLine != null ? String(totalLine) : "",
        side: g.total?.under,
      },
    ].map((row) => ({
      matchup,
      pitchers,
      proj,
      market: row.market,
      selection: row.selection,
      line: row.line,
      fair: row.side?.fairPrice || "",
      fairProb: row.side?.fairProb ?? null,
      book: row.side?.book || "",
      bookPrice: row.side?.bookPrice || "",
      edge: Number.isFinite(Number(row.side?.edge ?? row.side?.ev))
        ? Number(row.side?.edge ?? row.side?.ev)
        : null,
    }));
  });
}

function renderPrematchMarketRow(row) {
  return `
    <tr>
      <td class="selection-cell">
        <strong>${escapeHtml(row.matchup)}</strong>
        <span>${escapeHtml(row.pitchers || "—")}</span>
      </td>
      <td class="prematch-proj">
        <strong>${escapeHtml(row.proj)}</strong>
      </td>
      <td class="market-cell">${escapeHtml(row.market)}</td>
      <td>
        <strong>${escapeHtml(row.selection)}</strong>
      </td>
      <td><span class="line-value">${escapeHtml(row.line || "—")}</span></td>
      <td class="fair-cell">
        <strong>${escapeHtml(row.fair || "—")}</strong>
        ${
          row.fairProb != null && Number.isFinite(Number(row.fairProb))
            ? `<span>${(Number(row.fairProb) * 100).toFixed(1)}%</span>`
            : ""
        }
      </td>
      <td>
        ${
          row.book
            ? `<span class="book-pill">${escapeHtml(row.book)}</span>`
            : `<span class="book-pill muted-pill">—</span>`
        }
      </td>
      <td><span class="price">${escapeHtml(row.bookPrice || "—")}</span></td>
      <td><span class="ev-value ${prematchEdgeClass(row.edge)}">${escapeHtml(formatModelEv(row.edge))}</span></td>
    </tr>
  `;
}

function bindPrematchSortHeaders() {
  const table = elements.prematchCards?.querySelector(".prematch-table");
  if (!table || table.dataset.sortBound === "1") return;
  table.dataset.sortBound = "1";
  table.addEventListener("click", (event) => {
    const th = event.target.closest("[data-sort-key]");
    if (!th) return;
    const key = th.dataset.sortKey;
    if (state.prematchSort.key === key) {
      state.prematchSort.dir = state.prematchSort.dir === "desc" ? "asc" : "desc";
    } else {
      state.prematchSort.key = key;
      state.prematchSort.dir =
        key === "matchup" || key === "market" || key === "selection" || key === "book"
          ? "asc"
          : "desc";
    }
    renderPrematchCards();
  });
}

function renderPrematchCards() {
  const data = state.predictions;
  if (!elements.prematchCards) return;
  if (!data?.games?.length) {
    elements.prematchSummary.textContent =
      data?.error || "No Preview slate yet — rolling to next scheduled day when available.";
    elements.prematchMeta.innerHTML = "";
    elements.prematchCards.innerHTML = `<div class="live-odds-empty">No Pythagorean projections loaded.</div>`;
    state.prematchRows = [];
    return;
  }
  elements.prematchSummary.textContent = `${data.games.length} games · ${data.date} · Pythagorean exp ${data.exponent} · lg avg ${data.lgAvgRuns?.toFixed?.(2) ?? data.lgAvgRuns} R/G`;
  elements.prematchMeta.innerHTML = `
    <div class="prematch-meta-chip">Model: Bill James Pythagorean + log5 + starter ERA + HFA + L20</div>
    <div class="prematch-meta-chip">Click headers to sort · default highest edge</div>
  `;

  state.prematchRows = buildPrematchRowData(data);
  const sorted = sortPrematchRows(state.prematchRows);

  elements.prematchCards.innerHTML = `
    <div class="table-shell prematch-table-shell">
      <table class="prematch-table">
        <thead>
          <tr>
            ${prematchSortHeader("Matchup", "matchup")}
            ${prematchSortHeader("Proj score", "proj")}
            ${prematchSortHeader("Market", "market")}
            ${prematchSortHeader("Selection", "selection")}
            ${prematchSortHeader("Line", "line")}
            ${prematchSortHeader("Model fair", "fair")}
            ${prematchSortHeader("Book", "book")}
            ${prematchSortHeader("Book odds", "bookPrice")}
            ${prematchSortHeader("Edge", "edge")}
          </tr>
        </thead>
        <tbody>${sorted.map(renderPrematchMarketRow).join("")}</tbody>
      </table>
    </div>
  `;
  bindPrematchSortHeaders();
}

function renderOddsRows(odds) {
  return odds
    .map((odd) => {
      const bestLink = safeLink(odd.link);
      const details = (odd.quotes || []).map(quoteMarkup).join("");
      const flashExpiry = flashUntil.get(odd.id) || 0;
      const flashRemaining = flashExpiry - Date.now();
      const expanded = state.expandedOdds.has(odd.id);
      const flashAttrs =
        flashRemaining > 0
          ? ` class="row-flash" style="animation-delay:-${FLASH_MS - flashRemaining}ms"`
          : "";
      return `
        <tr${flashAttrs}>
          <td class="selection-cell">
            <strong>${escapeHtml(odd.name)}</strong>
            <span>${escapeHtml(odd.live ? "LIVE NOW" : formatStart(odd.startsAt))} · ${escapeHtml(odd.event)}</span>
          </td>
          <td class="market-cell">
            ${escapeHtml(odd.category)}
            <span class="market-sub">${escapeHtml(odd.market)}</span>
          </td>
          <td><span class="line-value">${escapeHtml(lineLabel(odd))}</span></td>
          <td>
            ${
              bestLink
                ? `<a class="book-pill best-book-link" href="${escapeHtml(bestLink)}" target="_blank" rel="noopener noreferrer">${escapeHtml(odd.sportsbook?.name)}</a>`
                : `<span class="book-pill">${escapeHtml(odd.sportsbook?.name)}</span>`
            }
          </td>
          <td><span class="price">${escapeHtml(odd.price)}</span></td>
          <td class="fair-cell">
            <strong>${escapeHtml(odd.fairPrice)}</strong>
            <span>${(odd.fairProbability * 100).toFixed(1)}% · ${odd.confidenceBooks} books</span>
          </td>
          <td><span class="ev-value ${odd.ev >= 0.03 ? "positive" : odd.ev <= -0.03 ? "negative" : ""}">${formatPercent(odd.ev)}</span></td>
          <td class="width-cell">${escapeHtml(widthLabel(odd))}</td>
          <td>
            <button class="depth-button" type="button" data-odd-id="${escapeHtml(odd.id)}" aria-expanded="${expanded}">
              ${expanded ? "Hide prices" : `${odd.quoteCount} prices`}
            </button>
          </td>
        </tr>
        <tr class="depth-row" data-odd-row="${escapeHtml(odd.id)}"${expanded ? "" : " hidden"}>
          <td colspan="9">
            <div class="depth-panel">
              <div>
                <span class="depth-label">Every available price</span>
                <p>Best-to-worst for this exact selection across synced sportsbooks.</p>
              </div>
              <div class="quote-grid">${details}</div>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function bindOddsBodyClicks(body) {
  if (!body || body.dataset.bound === "1") return;
  body.dataset.bound = "1";
  body.addEventListener("click", (event) => {
    const button = event.target.closest("[data-odd-id]");
    if (!button) return;
    const oddId = button.dataset.oddId;
    const row = [...body.querySelectorAll("[data-odd-row]")].find(
      (entry) => entry.dataset.oddRow === oddId,
    );
    if (!row) return;
    const opening = row.hidden;
    row.hidden = !opening;
    button.setAttribute("aria-expanded", String(opening));
    if (opening) state.expandedOdds.add(oddId);
    else state.expandedOdds.delete(oddId);
    const odd = state.odds.find((entry) => entry.id === oddId);
    button.textContent = opening ? "Hide prices" : `${odd?.quoteCount || 0} prices`;
  });
}

function renderGameChips() {
  const games = state.games || [];
  elements.liveEmpty.hidden = games.length > 0;
  elements.liveBoardSummary.textContent = games.length
    ? `${games.length} MLB game${games.length === 1 ? "" : "s"} · select one for play-by-play + odds`
    : "No MLB games on the ESPN board right now.";

  elements.gameChips.innerHTML = games
    .map((game) => {
      const active = game.id === state.selectedGameId ? " active" : "";
      const away = game.away?.abbreviation || "AWAY";
      const home = game.home?.abbreviation || "HOME";
      const score =
        game.status?.state === "pre"
          ? game.status.shortDetail || "Scheduled"
          : `${game.away?.score ?? 0}–${game.home?.score ?? 0}`;
      return `
        <button class="game-chip${active}" type="button" data-game-id="${escapeHtml(game.id)}">
          <strong>${escapeHtml(away)} @ ${escapeHtml(home)}</strong>
          <span>${escapeHtml(game.status?.description || "")}${
            game.injuryCount ? ` · ${game.injuryCount} injuries` : ""
          }</span>
          <span class="chip-score">${escapeHtml(score)}</span>
        </button>
      `;
    })
    .join("");
}

function formatSignedLine(line) {
  if (!Number.isFinite(Number(line))) return "";
  const value = Number(line);
  return value > 0 ? `+${value}` : String(value);
}

function relativeTime(iso) {
  if (!iso) return "unknown";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "unknown";
  if (ms < 5_000) return "just now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return new Date(iso).toLocaleTimeString();
}

function groupPlaysByInning(plays) {
  const groups = [];
  let current = null;
  for (const play of plays) {
    const period = play.period || "Inning";
    if (!current || current.period !== period) {
      current = { period, plays: [] };
      groups.push(current);
    }
    current.plays.push(play);
  }
  return groups;
}

function formatOddCell(label, side, { signedLine = false } = {}) {
  if (!side?.price) {
    return `<div class="odds-chip muted"><span>${escapeHtml(label)}</span><strong>—</strong></div>`;
  }
  let lineBit = "";
  if (side.line != null && side.line !== "") {
    lineBit = signedLine
      ? ` ${escapeHtml(formatSignedLine(side.line))}`
      : ` ${escapeHtml(String(side.line))}`;
  }
  const book = side.book ? ` · ${escapeHtml(side.book)}` : "";
  return `
    <div class="odds-chip">
      <span>${escapeHtml(label)}${lineBit}</span>
      <strong>${escapeHtml(String(side.price))}</strong>
      <em>${book.trim()}</em>
    </div>
  `;
}

function renderOddsBoard(odds, awayAbbr = "AWAY", homeAbbr = "HOME") {
  if (!odds) {
    return `<div class="live-odds-empty">No BoltOdds linked for this game yet — odds appear once the feed matches the ESPN matchup.</div>`;
  }
  const awayShort = awayAbbr || "AWAY";
  const homeShort = homeAbbr || "HOME";
  return `
    <div class="live-odds-strip">
      <div class="live-odds-group">
        <span class="live-odds-label">ML</span>
        ${formatOddCell(awayShort, odds.moneyline?.away)}
        ${formatOddCell(homeShort, odds.moneyline?.home)}
      </div>
      <div class="live-odds-group">
        <span class="live-odds-label">Spread</span>
        ${formatOddCell(awayShort, odds.spread?.away, { signedLine: true })}
        ${formatOddCell(homeShort, odds.spread?.home, { signedLine: true })}
      </div>
      <div class="live-odds-group">
        <span class="live-odds-label">Total${
          odds.total?.line != null ? ` ${escapeHtml(String(odds.total.line))}` : ""
        }</span>
        ${formatOddCell("Over", odds.total?.over)}
        ${formatOddCell("Under", odds.total?.under)}
      </div>
    </div>
  `;
}

function formatEdge(edge) {
  if (edge == null || !Number.isFinite(Number(edge))) return "—";
  const pct = Number(edge) * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function modelSideCell(label, side) {
  if (!side) {
    return `<div class="model-chip muted"><span>${escapeHtml(label)}</span><strong>—</strong></div>`;
  }
  const edge = Number(side.edge);
  const edgeClass =
    Number.isFinite(edge) && edge >= 0.03
      ? "edge-pos"
      : Number.isFinite(edge) && edge <= -0.03
        ? "edge-neg"
        : "";
  return `
    <div class="model-chip ${edgeClass}">
      <span>${escapeHtml(label)}</span>
      <div class="model-prices">
        <em>bk ${escapeHtml(side.bookPrice || "—")}</em>
        <strong>md ${escapeHtml(side.fairPrice || "—")}</strong>
      </div>
      <b class="model-edge">${escapeHtml(formatEdge(side.edge))}</b>
    </div>
  `;
}

function renderPythagModelBoard(model, awayAbbr = "AWAY", homeAbbr = "HOME") {
  if (!model?.moneyline) {
    return `<div class="live-odds-empty">Pythagorean prematch model loading or no season sample yet.</div>`;
  }
  const score = `${model.awayPredRuns ?? "—"} – ${model.homePredRuns ?? "—"}`;
  const pitchers = [
    model.awayPitcher
      ? `${awayAbbr}: ${model.awayPitcher}${
          model.awayPitcherEra != null ? ` (ERA ${model.awayPitcherEra})` : ""
        }`
      : null,
    model.homePitcher
      ? `${homeAbbr}: ${model.homePitcher}${
          model.homePitcherEra != null ? ` (ERA ${model.homePitcherEra})` : ""
        }`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return `
    <div class="inning-model-board pythag-model-board">
      <div class="inning-model-meta">
        <strong>Pythagorean prematch</strong>
        <span>Proj ${escapeHtml(score)} · Tot ${escapeHtml(String(model.totalPredRuns ?? "—"))}</span>
        <span>exp ${escapeHtml(String(model.exponent ?? "—"))}</span>
        ${pitchers ? `<span>${escapeHtml(pitchers)}</span>` : ""}
      </div>
      <div class="inning-model-card active">
        <div class="inning-model-title">Game markets · book vs model · EV</div>
        <div class="inning-model-row">
          <span class="live-odds-label">ML</span>
          ${modelSideCell(awayAbbr, model.moneyline?.away)}
          ${modelSideCell(homeAbbr, model.moneyline?.home)}
        </div>
        <div class="inning-model-row">
          <span class="live-odds-label">Spread ${escapeHtml(String(model.spread?.line ?? ""))}</span>
          ${modelSideCell(awayAbbr, model.spread?.away)}
          ${modelSideCell(homeAbbr, model.spread?.home)}
        </div>
        <div class="inning-model-row">
          <span class="live-odds-label">Total ${escapeHtml(String(model.total?.line ?? ""))}</span>
          ${modelSideCell("Over", model.total?.over)}
          ${modelSideCell("Under", model.total?.under)}
        </div>
      </div>
      <p class="inning-model-note">Bill James Pythagorean (mlb-pe): log5 + starter ERA blend + HFA + L20. EV = model prob × decimal − 1. Green = +EV ≥ 3%.</p>
    </div>
  `;
}

function renderInningModelBoard(model, awayAbbr = "AWAY", homeAbbr = "HOME") {
  if (!model?.innings || !Object.keys(model.innings).length) {
    return `<div class="live-odds-empty">Inning model waiting on live situation (outs / bases).</div>`;
  }
  const sit = model.situation || {};
  const bases = [
    sit.onFirst ? "1B" : null,
    sit.onSecond ? "2B" : null,
    sit.onThird ? "3B" : null,
  ]
    .filter(Boolean)
    .join("+") || "empty";
  const header = `
    <div class="inning-model-meta">
      <strong>Markov inning model</strong>
      <span>${escapeHtml(String(sit.half || ""))} ${escapeHtml(String(sit.activeInning || sit.inning || ""))} · ${escapeHtml(String(sit.outs ?? 0))} out · ${escapeHtml(bases)}</span>
      <span>RE rem ${escapeHtml(String(sit.outs != null ? (model.innings[sit.activeInning || sit.inning]?.state?.reRemaining ?? "—") : "—"))}</span>
      <span>λ inn ${escapeHtml(String(model.innings[sit.activeInning || sit.inning]?.lambdaTotal ?? "—"))}</span>
    </div>
  `;
  const cards = Object.keys(model.innings)
    .map(Number)
    .sort((a, b) => a - b)
    .map((n) => {
      const row = model.innings[n];
      const ordinal = ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th"][n - 1];
      const active = n === Number(sit.activeInning || sit.inning);
      return `
        <div class="inning-model-card${active ? " active" : ""}">
          <div class="inning-model-title">${ordinal} · ${escapeHtml(row.status || "")}</div>
          <div class="inning-model-row">
            <span class="live-odds-label">ML</span>
            ${modelSideCell(awayAbbr, row.moneyline?.away)}
            ${modelSideCell(homeAbbr, row.moneyline?.home)}
          </div>
          <div class="inning-model-row">
            <span class="live-odds-label">Spread ${escapeHtml(String(row.spread?.line ?? ""))}</span>
            ${modelSideCell(awayAbbr, row.spread?.away)}
            ${modelSideCell(homeAbbr, row.spread?.home)}
          </div>
          <div class="inning-model-row">
            <span class="live-odds-label">Total ${escapeHtml(String(row.total?.line ?? ""))}</span>
            ${modelSideCell("Over", row.total?.over)}
            ${modelSideCell("Under", row.total?.under)}
          </div>
        </div>
      `;
    })
    .join("");
  return `
    <div class="inning-model-board">
      ${header}
      <div class="inning-model-grid">${cards}</div>
      <p class="inning-model-note">${escapeHtml(model.methodology || "")} Edge = model prob − book implied.</p>
    </div>
  `;
}

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function downloadPlayDataframe(frame, game) {
  if (!frame?.columns?.length || !frame?.rows?.length) return;
  const lines = [
    frame.columns.join(","),
    ...frame.rows.map((row) =>
      frame.columns.map((col) => csvEscape(row[col])).join(","),
    ),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const label = `${game?.away?.abbreviation || "away"}_${game?.home?.abbreviation || "home"}`;
  anchor.href = url;
  anchor.download = `mlb_pbp_${label}_${stamp}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function cellValue(value) {
  if (value == null || value === "") return "—";
  return String(value);
}

function isNearBottom(shell, threshold = 96) {
  if (!shell) return false;
  return shell.scrollHeight - shell.scrollTop - shell.clientHeight <= threshold;
}

function restoreScroll(shell, { prevTop = 0, followLatest = false } = {}) {
  if (!shell) return;
  if (followLatest) {
    shell.scrollTop = shell.scrollHeight;
  } else {
    shell.scrollTop = prevTop;
  }
}

function scrollLatestIntoFrame() {
  const shell = elements.livePlays.querySelector(".pbp-frame-shell");
  const target = elements.livePlays.querySelector("#latestPlay");
  if (!shell || !target) return;
  const top = Math.max(0, target.offsetTop - 36);
  shell.scrollTop = top;
}

function columnCellClass(col) {
  const classes = [];
  if (col === "play_n") classes.push("col-sticky");
  else if (col === "inning") classes.push("col-sticky-2");
  else if (col === "type") classes.push("col-sticky-3");

  if (col === "text") classes.push("col-text");
  else if (
    col.includes("ml") ||
    col.includes("spread") ||
    col.includes("odds") ||
    col.includes("total") ||
    col.includes("consensus") ||
    col.includes("batter_") ||
    col.includes("pitcher_") ||
    col.startsWith("over_") ||
    col.startsWith("under_") ||
    col.endsWith("_book") ||
    col.endsWith("_best")
  ) {
    classes.push("col-odds");
  }
  return classes.join(" ");
}

function bindPbpShellScroll(shell, { prevTop = 0, followLatest = false } = {}) {
  if (!shell) return;
  restoreScroll(shell, { prevTop, followLatest });
  shell.onscroll = () => {
    state.pbpFollowLatest = isNearBottom(shell);
  };
  // Wheel scrolls horizontally when shift is held, or when the gesture is mostly sideways.
  shell.onwheel = (event) => {
    const mostlyHorizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
    if (event.shiftKey || mostlyHorizontal) {
      const delta = event.shiftKey ? event.deltaY || event.deltaX : event.deltaX;
      if (!delta) return;
      shell.scrollLeft += delta;
      event.preventDefault();
    }
  };
}

function renderPlayDataframe(frame, { scrollToLatest = false } = {}) {
  if (!frame?.rows?.length) {
    return `<div class="live-odds-empty">No plays yet for this game.</div>`;
  }
  const columns = frame.columns || Object.keys(frame.rows[0] || {});
  const head = columns
    .map(
      (col) =>
        `<th class="${columnCellClass(col)}" title="${escapeHtml(col)}">${escapeHtml(col)}</th>`,
    )
    .join("");
  const body = frame.rows
    .map((row, index) => {
      const latest = Number(row.is_latest) === 1 || index === frame.rows.length - 1;
      const scoring = Number(row.scoring_play) === 1;
      const cells = columns
        .map((col) => {
          const raw = row[col];
          return `<td class="${columnCellClass(col)}">${escapeHtml(cellValue(raw))}</td>`;
        })
        .join("");
      return `<tr class="${[
        latest ? "latest" : "",
        scoring ? "scoring" : "",
      ]
        .filter(Boolean)
        .join(" ")}"${latest ? ' id="latestPlay"' : ""}>${cells}</tr>`;
    })
    .join("");

  // Defer scroll until after DOM paint by caller.
  if (scrollToLatest) {
    /* no-op placeholder for callers */
  }

  return `
    <div class="pbp-frame-shell" tabindex="0" title="Shift+scroll for horizontal">
      <table class="pbp-frame">
        <thead><tr>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

function playStateLabel(play, game) {
  const awayAbbr = game.away?.abbreviation || "AWAY";
  const homeAbbr = game.home?.abbreviation || "HOME";
  const state = play.gameState || {};
  const score =
    state.awayScore != null && state.homeScore != null
      ? `${awayAbbr} ${state.awayScore}–${state.homeScore} ${homeAbbr}`
      : play.awayScore != null && play.homeScore != null
        ? `${awayAbbr} ${play.awayScore}–${play.homeScore} ${homeAbbr}`
        : "";
  return [play.clock, score].filter(Boolean).join(" · ");
}

function renderLiveDetail(detail) {
  if (!detail?.game) {
    elements.liveDetail.hidden = true;
    return;
  }
  const pageScrollY = window.scrollY;
  elements.liveDetail.hidden = false;
  const game = detail.game;
  const away = game.away || {};
  const home = game.home || {};
  const awayAbbr = away.abbreviation || "AWAY";
  const homeAbbr = home.abbreviation || "HOME";
  const plays = detail.plays || [];
  const frame =
    detail.dataframe ||
    ({
      columns: [],
      rows: [],
    });
  state.playDataframe = frame;
  const inningsCovered = [
    ...new Set(frame.rows.map((row) => row.inning).filter(Boolean)),
  ];

  elements.liveScorecard.innerHTML = `
    <div class="live-score-teams">
      <div class="live-score-team">
        ${away.logo ? `<img src="${escapeHtml(away.logo)}" alt="" />` : ""}
        <div>
          <strong>${escapeHtml(away.name || "Away")}</strong>
          <span>${escapeHtml(away.record || away.abbreviation || "")}</span>
        </div>
        <div class="live-score-value">${escapeHtml(String(away.score ?? "0"))}</div>
      </div>
      <div class="live-score-team">
        ${home.logo ? `<img src="${escapeHtml(home.logo)}" alt="" />` : ""}
        <div>
          <strong>${escapeHtml(home.name || "Home")}</strong>
          <span>${escapeHtml(home.record || home.abbreviation || "")}</span>
        </div>
        <div class="live-score-value">${escapeHtml(String(home.score ?? "0"))}</div>
      </div>
    </div>
    <div class="live-score-meta">
      <div>${escapeHtml(game.status?.detail || game.status?.description || "")}</div>
      <div>${escapeHtml(game.venue || "")}</div>
      ${
        detail.winProbability?.homeWinPct != null
          ? `<div>Home win prob ${(Number(detail.winProbability.homeWinPct) * 100).toFixed(1)}%</div>`
          : ""
      }
      ${
        game.matchedEvent
          ? `<div>Odds linked · ${escapeHtml(game.matchedEvent)}</div>`
          : "<div>No matching BoltOdds event yet</div>"
      }
    </div>
  `;

  if (elements.livePbpMeta) {
    const latestText = detail.latestPlay?.text
      ? detail.latestPlay.text.slice(0, 90)
      : "waiting for plays";
    elements.livePbpMeta.innerHTML = `
      <div class="live-pbp-meta-row">
        <strong>${frame.rows.length || plays.length} rows</strong>
        <span>${frame.columns.length} columns</span>
        <span>${inningsCovered.length ? escapeHtml(inningsCovered.join(" · ")) : "No innings yet"}</span>
        <span>Updated ${escapeHtml(relativeTime(detail.fetchedAt))}</span>
        <button type="button" class="jump-latest" id="downloadPbpCsv">Download CSV</button>
        <button type="button" class="jump-latest" id="jumpLatest">Jump to latest</button>
      </div>
      <div class="live-pbp-latest-line">
        <span class="latest-badge">Latest</span>
        ${escapeHtml(latestText)}
      </div>
    `;
    const jump = elements.livePbpMeta.querySelector("#jumpLatest");
    if (jump) {
      jump.addEventListener("click", () => {
        state.pbpFollowLatest = true;
        scrollLatestIntoFrame();
      });
    }
    const download = elements.livePbpMeta.querySelector("#downloadPbpCsv");
    if (download) {
      download.addEventListener("click", () =>
        downloadPlayDataframe(state.playDataframe, game),
      );
    }
  }

  elements.liveBoardOdds.innerHTML = `
    <div class="live-odds-now-label">Live board now</div>
    ${renderOddsBoard(detail.liveOdds, awayAbbr, homeAbbr)}
    ${renderPythagModelBoard(detail.pythagModel, awayAbbr, homeAbbr)}
    ${renderInningModelBoard(detail.inningModel, awayAbbr, homeAbbr)}
  `;

  const prevShell = elements.livePlays.querySelector(".pbp-frame-shell");
  const prevShellTop = prevShell?.scrollTop ?? 0;
  const wasNearBottom = isNearBottom(prevShell);
  const isFirstPaint = !(state.lastPlayCountByGame?.[game.id] > 0);
  const followLatest =
    isFirstPaint || state.pbpFollowLatest || wasNearBottom;

  elements.livePlays.innerHTML = frame.rows.length
    ? renderPlayDataframe(frame)
    : `<div class="live-odds-empty">No plays yet — game is ${escapeHtml(
        game.status?.description || "not started",
      )}.</div>`;

  state.lastPlayCountByGame = {
    ...(state.lastPlayCountByGame || {}),
    [game.id]: frame.rows.length || plays.length,
  };

  const shell = elements.livePlays.querySelector(".pbp-frame-shell");
  bindPbpShellScroll(shell, { prevTop: prevShellTop, followLatest });
  // Keep the page where the user left it — never jump the window on live refresh.
  window.scrollTo(0, pageScrollY);

  const leaderBlocks = (detail.leaders || [])
    .map(
      (block) => `
      <div class="live-stat-block">
        <strong>${escapeHtml(block.category)}</strong>
        ${(block.leaders || [])
          .map(
            (leader) =>
              `<span>${escapeHtml(leader.athlete)}${
                leader.team ? ` (${escapeHtml(leader.team)})` : ""
              } · ${escapeHtml(leader.value)}</span>`,
          )
          .join("")}
      </div>
    `,
    )
    .join("");

  const teamStatBlocks = (detail.teamStats || [])
    .map(
      (team) => `
      <div class="live-stat-block">
        <strong>${escapeHtml(team.abbreviation || team.team)} team stats</strong>
        ${(team.stats || [])
          .slice(0, 8)
          .map((stat) => `<span>${escapeHtml(stat.label)}: ${escapeHtml(stat.value)}</span>`)
          .join("")}
      </div>
    `,
    )
    .join("");

  elements.liveStats.innerHTML =
    leaderBlocks || teamStatBlocks
      ? `${leaderBlocks}${teamStatBlocks}`
      : `<div class="live-stat-block"><span>Stats will appear once the game is underway.</span></div>`;

  const injuries = detail.injuries || [];
  elements.liveInjuries.innerHTML = injuries.length
    ? injuries
        .map(
          (inj) => `
        <div class="live-injury">
          <strong>${escapeHtml(inj.player)}${inj.position ? ` · ${escapeHtml(inj.position)}` : ""}</strong>
          <span>${escapeHtml(inj.team)} · ${escapeHtml(inj.status)}${
            inj.injury ? ` · ${escapeHtml(inj.injury)}` : ""
          }</span>
          ${inj.note ? `<span>${escapeHtml(inj.note)}</span>` : ""}
        </div>
      `,
        )
        .join("")
    : `<div class="live-injury"><span>No listed injuries for these teams.</span></div>`;
}

async function loadLiveBoard() {
  try {
    const response = await fetch(apiUrl("live"), { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Live board unavailable");
    state.games = Array.isArray(data.games) ? data.games : [];
    if (
      state.selectedGameId &&
      !state.games.some((game) => game.id === state.selectedGameId)
    ) {
      state.selectedGameId = null;
      state.selectedEvent = null;
    }
    if (!state.selectedGameId && state.games.length) {
      const preferred =
        state.games.find((game) => game.status?.state === "in") || state.games[0];
      state.selectedGameId = preferred.id;
      state.selectedEvent = preferred.matchedEvent || null;
    }
    renderGameChips();
    if (state.selectedGameId) await loadGameDetail(state.selectedGameId);
    else {
      elements.liveDetail.hidden = true;
      render();
    }
  } catch (error) {
    elements.liveBoardSummary.textContent = error.message;
    elements.liveEmpty.hidden = false;
    elements.liveEmpty.textContent = error.message;
  }
}

async function loadGameDetail(eventId) {
  try {
    const response = await fetch(apiUrl(`live/${encodeURIComponent(eventId)}`), {
      cache: "no-store",
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Game detail unavailable");
    state.selectedEvent = data.game?.matchedEvent || state.selectedEvent;
    renderLiveDetail(data);
    renderGameChips();
    render();
  } catch (error) {
    elements.liveDetail.hidden = false;
    elements.liveScorecard.innerHTML = `<div class="live-score-meta">${escapeHtml(error.message)}</div>`;
    if (elements.liveBoardOdds) elements.liveBoardOdds.innerHTML = "";
    if (elements.livePbpMeta) elements.livePbpMeta.innerHTML = "";
    elements.livePlays.innerHTML = "";
    elements.liveStats.innerHTML = "";
    elements.liveInjuries.innerHTML = "";
  }
}

function render() {
  if (!state.hasLoaded && state.tab !== "live") return;

  if (state.tab === "value" || state.hasLoaded) renderArbs();
  if (state.tab === "prematch") renderPrematchCards();

  const categories = [
    ...new Set(
      state.odds
        .map((odd) => odd.category)
        .filter((cat) => cat && !/inning/i.test(cat)),
    ),
  ].sort((a, b) => a.localeCompare(b));

  const valueCategories = categories.filter((cat) => {
    if (GAME_MARKETS.has(cat) || PROP_MARKETS.has(cat)) return true;
    return marketGroup({ category: cat }) !== "inning";
  });

  if (elements.valueMarket) {
    setOptions(
      elements.valueMarket,
      valueCategories.map((category) => ({ value: category, label: category })),
      "All categories",
    );
  }

  if (elements.valueOddsBody) {
    const valueOdds = currentValueOdds();
    elements.valueOddsBody.innerHTML = renderOddsRows(valueOdds);
    elements.valueEmpty.hidden = valueOdds.length > 0;
    if (elements.valueSummary) {
      elements.valueSummary.textContent = `${valueOdds.length} +EV selection${
        valueOdds.length === 1 ? "" : "s"
      } · min ${((Number(elements.valueMinEv?.value) || 0) * 100).toFixed(0)}% · game / props`;
    }
    bindOddsBodyClicks(elements.valueOddsBody);
  }
}

function updateSummary(data) {
  const books = (data.feeds || [])
    .map((feed) => feed.sportsbook)
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));

  elements.lineCount.textContent = state.odds.length.toLocaleString();
  elements.bookCount.textContent = books.length.toLocaleString();
  const plusEvCount = state.odds.filter(
    (o) =>
      Number.isFinite(o.ev) &&
      o.ev >= 0.03 &&
      marketGroup(o) !== "inning",
  ).length;
  elements.arbCount.textContent = `${plusEvCount} / ${state.arbs.length}`;
  elements.updatedAt.textContent = formatTime(data.feedUpdated || data.fetchedAt);
  elements.message.hidden = false;
  const freshness = (data.marketSyncs || [])
    .map((sync) => `${sync.market}: ${formatAge(sync.syncedAt)}`)
    .join(" · ");
  elements.message.textContent = `${data.methodology || "EV from model / no-vig consensus."} Active: ${data.activeMarket || "connecting"}. Last synced: ${freshness}`;
}

async function loadPredictions() {
  if (!elements.prematchSummary) return;
  elements.prematchSummary.textContent = "Loading Pythagorean slate…";
  try {
    const response = await fetch(apiUrl("predictions"), { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Predictions unavailable");
    state.predictions = data;
    renderPrematchCards();
  } catch (error) {
    state.predictions = { games: [], error: error.message };
    renderPrematchCards();
  }
}

async function loadOdds() {
  if (state.loading) {
    state.queued = true;
    return;
  }
  state.loading = true;
  elements.refresh.classList.add("loading");
  elements.refresh.disabled = true;
  if (!state.hasLoaded && elements.loading) elements.loading.hidden = false;

  try {
    const response = await fetch(apiUrl("odds"), { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to load the live feed");

    state.odds = Array.isArray(data.odds) ? data.odds : [];
    state.arbs = Array.isArray(data.arbs) ? data.arbs : [];
    state.feeds = Array.isArray(data.feeds) ? data.feeds : [];
    const liveIds = new Set(state.odds.map((odd) => odd.id));
    for (const id of state.expandedOdds) {
      if (!liveIds.has(id)) state.expandedOdds.delete(id);
    }
    state.hasLoaded = true;
    trackChanges(state.odds);
    updateSummary(data);
    render();

    if (LIVE_API_BASE) {
      elements.status.textContent = data.connected
        ? `Live · ${data.activeMarket || "market"}`
        : "Live · switching market";
      elements.pulse.className = data.connected ? "pulse connected" : "pulse";
    } else if (STATIC_MODE) {
      elements.status.textContent = "GitHub Pages snapshot";
      elements.pulse.className = "pulse connected";
    } else {
      elements.status.textContent = data.connected
        ? `Syncing ${data.activeMarket || "market"}`
        : "Switching market";
      elements.pulse.className = data.connected ? "pulse connected" : "pulse";
    }
  } catch (error) {
    state.hasLoaded = true;
    elements.status.textContent = "Feed connection error";
    elements.pulse.className = "pulse error";
    if (elements.message) {
      elements.message.hidden = false;
      elements.message.textContent = error.message;
    }
  } finally {
    if (elements.loading) elements.loading.hidden = true;
    state.loading = false;
    elements.refresh.classList.remove("loading");
    elements.refresh.disabled = false;
    if (state.queued) {
      state.queued = false;
      loadOdds();
    }
  }
}

for (const control of [
  elements.valueSearch,
  elements.valueGroup,
  elements.valueMarket,
  elements.valueMinEv,
  elements.valueTiming,
]) {
  if (!control) continue;
  control.addEventListener(
    control.tagName === "INPUT" ? "input" : "change",
    render,
  );
}

for (const btn of elements.tabButtons) {
  btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
}

elements.gameChips.addEventListener("click", (event) => {
  const chip = event.target.closest("[data-game-id]");
  if (!chip) return;
  const gameId = chip.dataset.gameId;
  if (state.selectedGameId === gameId) {
    state.selectedGameId = null;
    state.selectedEvent = null;
    elements.liveDetail.hidden = true;
    renderGameChips();
    return;
  }
  const game = state.games.find((entry) => entry.id === gameId);
  state.selectedGameId = gameId;
  state.selectedEvent = game?.matchedEvent || null;
  state.pbpFollowLatest = true;
  state.lastPlayCountByGame = {
    ...(state.lastPlayCountByGame || {}),
    [gameId]: 0,
  };
  renderGameChips();
  loadGameDetail(gameId);
});

elements.refresh.addEventListener("click", () => {
  loadOdds();
  loadLiveBoard();
  if (state.tab === "prematch") loadPredictions();
});

if (!STATIC_MODE) {
  const streamUrl = LIVE_API_BASE ? `${LIVE_API_BASE}/api/stream` : "/api/stream";
  const stream = new EventSource(streamUrl);
  stream.addEventListener("update", loadOdds);
  stream.addEventListener("connected", () => {
    elements.status.textContent = LIVE_API_BASE
      ? "Real-time feed connected"
      : "Real-time feed connected";
    elements.pulse.className = "pulse connected";
  });
  stream.onerror = () => {
    elements.status.textContent = "Reconnecting live updates";
    elements.pulse.className = "pulse";
  };
} else {
  elements.status.textContent = "GitHub Pages snapshot";
  elements.pulse.className = "pulse connected";
}

setInterval(() => {
  if (!document.hidden) loadOdds();
}, STATIC_MODE ? 60_000 : 30_000);

setInterval(() => {
  if (!document.hidden && state.tab === "live") loadLiveBoard();
}, 12_000);

setInterval(() => {
  if (!document.hidden && state.tab === "prematch") loadPredictions();
}, 10 * 60 * 1000);

loadOdds();
loadLiveBoard();
