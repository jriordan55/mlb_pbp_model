const elements = {
  body: document.querySelector("#oddsBody"),
  loading: document.querySelector("#loadingState"),
  empty: document.querySelector("#emptyState"),
  emptyTitle: document.querySelector("#emptyTitle"),
  emptyCopy: document.querySelector("#emptyCopy"),
  message: document.querySelector("#feedMessage"),
  search: document.querySelector("#searchInput"),
  market: document.querySelector("#marketSelect"),
  book: document.querySelector("#bookSelect"),
  bestBook: document.querySelector("#bestBookSelect"),
  positiveOnly: document.querySelector("#positiveOnly"),
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
};

const state = {
  odds: [],
  arbs: [],
  feeds: [],
  games: [],
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

function currentOdds() {
  const query = elements.search.value.trim().toLowerCase();
  return state.odds.filter((odd) => {
    const searchable = [odd.name, odd.market, odd.category, odd.event]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const offeredByBook =
      !elements.book.value ||
      (odd.quotes || []).some(
        (quote) => quote.sportsbook?.id === elements.book.value,
      );
    const matchesSelectedGame =
      !state.selectedEvent || odd.event === state.selectedEvent;
    return (
      (!query || searchable.includes(query)) &&
      (!elements.market.value || odd.category === elements.market.value) &&
      offeredByBook &&
      (!elements.bestBook.value || odd.sportsbook?.id === elements.bestBook.value) &&
      (!elements.positiveOnly.checked || odd.ev > 0) &&
      matchesSelectedGame
    );
  });
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
    (arb) => !state.selectedEvent || arb.event === state.selectedEvent,
  );
  elements.arbCount.textContent = (state.arbs || []).length.toLocaleString();
  elements.arbEmpty.hidden = arbs.length > 0;
  elements.arbSummary.textContent = arbs.length
    ? `${arbs.length} two-way arb${arbs.length === 1 ? "" : "s"}${
        state.selectedEvent ? " for selected game" : ""
      } · stakes sized for $100 total`
    : state.selectedEvent
      ? "No two-way arbs for the selected game."
      : "No two-way arbs right now across Moneyline, Spread, and Total.";

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

function renderGameChips() {
  const games = state.games || [];
  elements.liveEmpty.hidden = games.length > 0;
  elements.liveBoardSummary.textContent = games.length
    ? `${games.length} MLB game${games.length === 1 ? "" : "s"} · select one to filter odds and open live context`
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
    const response = await fetch("/api/live", { cache: "no-store" });
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
    const response = await fetch(`/api/live/${encodeURIComponent(eventId)}`, {
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
  if (!state.hasLoaded) return;
  renderArbs();
  const odds = currentOdds();

  elements.body.innerHTML = odds
    .map((odd) => {
      const bestLink = safeLink(odd.link);
      const details = (odd.quotes || []).map(quoteMarkup).join("");
      const flashExpiry = flashUntil.get(odd.id) || 0;
      const flashRemaining = flashExpiry - Date.now();
      const expanded = state.expandedOdds.has(odd.id);
      // Negative delay resumes the animation mid-flight when rows re-render.
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
          <td><span class="ev-value ${odd.ev >= 0 ? "positive" : "negative"}">${formatPercent(odd.ev)}</span></td>
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
                <p>Best-to-worst for this exact selection. EV uses a median no-vig consensus.</p>
              </div>
              <div class="quote-grid">${details}</div>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  elements.empty.hidden = odds.length > 0;
  if (!odds.length) {
    const filtersActive =
      elements.search.value ||
      elements.market.value ||
      elements.book.value ||
      elements.positiveOnly.checked;
    elements.emptyTitle.textContent = filtersActive
      ? "No MLB lines match these filters"
      : "No MLB lines found";
    elements.emptyCopy.textContent = filtersActive
      ? "Try clearing a filter or selecting another market."
      : "BoltOdds has not synced any MLB rotation markets yet.";
  }
}

function updateSummary(data) {
  const categories = [
    ...new Set(state.odds.map((odd) => odd.category).filter(Boolean)),
  ].sort();
  const books = (data.feeds || [])
    .map((feed) => feed.sportsbook)
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));

  setOptions(
    elements.market,
    categories.map((category) => ({ value: category, label: category })),
    "All synced markets",
  );
  setOptions(
    elements.book,
    books.map((book) => ({ value: book.id, label: book.name })),
    "All sportsbooks",
  );

  const bestBooks = [
    ...new Map(
      state.odds
        .filter((odd) => odd.sportsbook?.id)
        .map((odd) => [odd.sportsbook.id, odd.sportsbook]),
    ).values(),
  ].sort((a, b) => a.name.localeCompare(b.name));
  setOptions(
    elements.bestBook,
    bestBooks.map((book) => ({ value: book.id, label: book.name })),
    "Any best book",
  );

  elements.lineCount.textContent = state.odds.length.toLocaleString();
  elements.bookCount.textContent = books.length.toLocaleString();
  elements.arbCount.textContent = state.arbs.length.toLocaleString();
  elements.updatedAt.textContent = formatTime(data.feedUpdated || data.fetchedAt);
  elements.message.hidden = false;
  const freshness = (data.marketSyncs || [])
    .map((sync) => `${sync.market}: ${formatAge(sync.syncedAt)}`)
    .join(" · ");
  elements.message.textContent = `${data.methodology || "EV is calculated from a no-vig consensus across books offering both sides."} Active: ${data.activeMarket || "connecting"}. Last synced: ${freshness}`;
}

async function loadOdds() {
  if (state.loading) {
    state.queued = true;
    return;
  }
  state.loading = true;
  elements.refresh.classList.add("loading");
  elements.refresh.disabled = true;
  if (!state.hasLoaded) elements.loading.hidden = false;

  try {
    const response = await fetch("/api/odds", { cache: "no-store" });
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

    elements.status.textContent = data.connected
      ? `Syncing ${data.activeMarket || "market"}`
      : "Switching market";
    elements.pulse.className = data.connected ? "pulse connected" : "pulse";
  } catch (error) {
    state.hasLoaded = true;
    elements.empty.hidden = false;
    elements.emptyTitle.textContent = "Live feed unavailable";
    elements.emptyCopy.textContent = error.message;
    elements.status.textContent = "Feed connection error";
    elements.pulse.className = "pulse error";
  } finally {
    elements.loading.hidden = true;
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
  elements.search,
  elements.market,
  elements.book,
  elements.bestBook,
  elements.positiveOnly,
]) {
  control.addEventListener(control === elements.search ? "input" : "change", render);
}

elements.body.addEventListener("click", (event) => {
  const button = event.target.closest("[data-odd-id]");
  if (!button) return;
  const oddId = button.dataset.oddId;
  const row = [...elements.body.querySelectorAll("[data-odd-row]")].find(
    (entry) => entry.dataset.oddRow === oddId,
  );
  if (!row) return;
  const opening = row.hidden;
  row.hidden = !opening;
  button.setAttribute("aria-expanded", String(opening));
  if (opening) state.expandedOdds.add(oddId);
  else state.expandedOdds.delete(oddId);
  const odd = currentOdds().find((entry) => entry.id === oddId);
  button.textContent = opening ? "Hide prices" : `${odd?.quoteCount || 0} prices`;
});

elements.gameChips.addEventListener("click", (event) => {
  const chip = event.target.closest("[data-game-id]");
  if (!chip) return;
  const gameId = chip.dataset.gameId;
  if (state.selectedGameId === gameId) {
    state.selectedGameId = null;
    state.selectedEvent = null;
    elements.liveDetail.hidden = true;
    renderGameChips();
    render();
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
});

const stream = new EventSource("/api/stream");
stream.addEventListener("update", loadOdds);
stream.addEventListener("connected", () => {
  elements.status.textContent = "Real-time feed connected";
  elements.pulse.className = "pulse connected";
});
stream.onerror = () => {
  elements.status.textContent = "Reconnecting live updates";
  elements.pulse.className = "pulse";
};

// Safety refresh in case a browser or proxy interrupts the event stream.
setInterval(() => {
  if (!document.hidden) loadOdds();
}, 30_000);

// Live PBP / scoreboard — keep selected game current.
setInterval(() => {
  if (!document.hidden) loadLiveBoard();
}, 12_000);

loadOdds();
loadLiveBoard();
