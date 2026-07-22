const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const WebSocket = globalThis.WebSocket || require("ws");
const { buildLiveBoard, buildGameDetail } = require("./espn");
const { sendTelegram, telegramConfigured } = require("./telegram");
const {
  buildInningModelBoard,
  inningMarketName,
} = require("./markov/inning_markets");
const {
  buildPrematchPredictions,
  findPredictionForMatchup,
  enrichWithBooks,
} = require("./pythag/mlb_stats");
const { dropAlternateSpreads, isAlternateMarketName } = require("./market_filters");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
loadEnv(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT) || 3000;
const BOLT_KEY = process.env.BOLTODDS_API_KEY;
const RECONNECT_DELAY_MS = 5_000;
const MARKET_DWELL_MS = 6_000;

const SPORT = "MLB";
const GAME_MARKETS = ["Moneyline", "Spread", "Total"];
const INNING_ORDINALS = ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th"];
const INNING_MARKETS = INNING_ORDINALS.flatMap((ordinal) => [
  `${ordinal} Inning Moneyline`,
  `${ordinal} Inning Spread`,
  `${ordinal} Inning Total`,
]);
const BATTER_PROP_MARKETS = [
  "Hits",
  "Home Runs",
  "RBIs",
  "Runs",
  "Bases",
  "Hits + Runs + RBIs",
];
const PITCHER_PROP_MARKETS = ["Strikeouts Thrown", "Outs"];
const PROP_MARKETS = [...BATTER_PROP_MARKETS, ...PITCHER_PROP_MARKETS];
const ROTATION_MARKETS = [...GAME_MARKETS, ...INNING_MARKETS, ...PROP_MARKETS];
const TARGET_MARKETS = new Map(
  ROTATION_MARKETS.map((market) => [market, market]),
);
const PROP_MARKET_SET = new Set(PROP_MARKETS);
const GAME_MARKET_SET = new Set([...GAME_MARKETS, ...INNING_MARKETS]);

/** Live-table prop columns: market name → dataframe prefix. */
const BATTER_PROP_SPECS = [
  { market: "Hits", prefix: "batter_hits" },
  { market: "Home Runs", prefix: "batter_hr" },
  { market: "RBIs", prefix: "batter_rbi" },
  { market: "Runs", prefix: "batter_runs" },
  { market: "Bases", prefix: "batter_bases" },
  { market: "Hits + Runs + RBIs", prefix: "batter_hrrbi" },
];
const PITCHER_PROP_SPECS = [
  { market: "Strikeouts Thrown", prefix: "pitcher_ks" },
  { market: "Outs", prefix: "pitcher_outs" },
];

// Live table + feed subscription: sharp retail books plus BoltOdds market consensus.
const ALLOWED_SPORTSBOOKS = [
  "fanduel",
  "draftkings",
  "betmgm",
  "betonline",
  "thescore",
  "consensus",
];

const BOOK_LABELS = {
  fanduel: "FanDuel",
  draftkings: "DraftKings",
  betmgm: "BetMGM",
  betonline: "BetOnline",
  thescore: "theScore",
  consensus: "Consensus",
};

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

// ---------------------------------------------------------------------------
// BoltOdds live feed (WebSocket)
// ---------------------------------------------------------------------------

// key: `${sportsbook}|${game}|${market}` -> { sportsbook, game, market, info, outcomes: Map }
const feedState = new Map();
const streamClients = new Set();
const marketSyncedAt = new Map();
/** First-seen odds stamp per ESPN play: `${eventId}|${playId}` -> odds board. */
const playOddsMemory = new Map();
let socketConnected = false;
let lastMessageAt = null;
let broadcastTimer = null;
let rotationIndex = 0;
let activeMarket = ROTATION_MARKETS[0];
let activeSocket = null;
let reconnectTimer = null;
let rotationTimer = null;

let alertTimer = null;

// Throttled so the browser re-renders at most every 2s, letting the row
// flash animation (1.4s) finish before the next update replaces the rows.
function scheduleBroadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const message = `event: update\ndata: ${JSON.stringify({ updated: lastMessageAt })}\n\n`;
    for (const client of streamClients) client.write(message);
    scheduleOddsAlerts();
  }, 2000);
}

function scheduleOddsAlerts() {
  if (!telegramConfigured() || alertTimer) return;
  alertTimer = setTimeout(() => {
    alertTimer = null;
    maybeSendOddsAlerts().catch((error) =>
      console.error("Telegram alert error:", error.message || error),
    );
  }, 1500);
}

async function maybeSendOddsAlerts() {
  let snapshot;
  try {
    snapshot = buildSnapshot();
  } catch {
    return;
  }
  const minEv = Number(process.env.TELEGRAM_MIN_EV) || 0.03;
  const minArb = Number(process.env.TELEGRAM_MIN_ARB) || 0.01;
  const maxAlertOdds = Number(process.env.TELEGRAM_MAX_ODDS) || 200;
  // Alerts: player props only, and no price longer than +maxAlertOdds.
  const isPropMarket = (name) => PROP_MARKET_SET.has(String(name || ""));
  const withinOddsCap = (price) => {
    const american = parseAmerican(price);
    return american !== null && american <= maxAlertOdds;
  };

  for (const arb of snapshot.arbs || []) {
    if (!isPropMarket(arb.category) && !isPropMarket(arb.market)) continue;
    if (!(arb.profit >= minArb)) continue;
    if (!(arb.legs || []).every((leg) => withinOddsCap(leg.price))) continue;
    const legs = (arb.legs || [])
      .map(
        (leg) =>
          `${leg.target || leg.name}${
            leg.line != null ? ` ${leg.line}` : ""
          } ${leg.price} @ ${leg.sportsbook?.name || leg.sportsbook?.id || "?"}`,
      )
      .join("\n");
    await sendTelegram(
      `ARB +${(arb.profit * 100).toFixed(1)}%\n${arb.event}\n${arb.category || ""}\n${legs}`,
      { key: `arb:${arb.id}` },
    );
  }

  for (const odd of snapshot.odds || []) {
    if (!isPropMarket(odd.category) && !isPropMarket(odd.market)) continue;
    if (!withinOddsCap(odd.price)) continue;
    if (!(odd.ev >= minEv)) continue;
    const line =
      odd.line != null
        ? `${odd.side || ""} ${odd.line}`.trim()
        : odd.side || "ML";
    await sendTelegram(
      `+EV ${(odd.ev * 100).toFixed(1)}%\n${odd.event}\n${odd.category} · ${odd.name} · ${line}\n${odd.price} @ ${odd.sportsbook?.name || "?"}\nFair ${odd.fairPrice || "—"} (${(
        (odd.fairProbability || 0) * 100
      ).toFixed(1)}%)`,
      { key: `ev:${odd.id}` },
    );
  }
}

function bookLabel(id) {
  return BOOK_LABELS[id] || id.charAt(0).toUpperCase() + id.slice(1);
}

// "2026-07-16, 12:00 AM" -> ISO string (treated as server-local time)
function parseWhen(when) {
  const match = String(when || "").match(
    /(\d{4})-(\d{2})-(\d{2}),\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i,
  );
  if (!match) return null;
  let hours = Number(match[4]) % 12;
  if (/pm/i.test(match[6])) hours += 12;
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    hours,
    Number(match[5]),
  );
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function applyOutcomes(entry, outcomes, replace) {
  if (replace) entry.outcomes.clear();
  for (const [key, outcome] of Object.entries(outcomes || {})) {
    if (!outcome || outcome.odds === null || outcome.odds === "") {
      entry.outcomes.delete(key);
    } else {
      entry.outcomes.set(key, outcome);
    }
  }
}

function handleFeedItem(item, market) {
  const data = item.data;
  if (!data || data.sport !== SPORT) return;
  if (data.sportsbook && !ALLOWED_SPORTSBOOKS.includes(data.sportsbook)) return;
  lastMessageAt = new Date().toISOString();
  marketSyncedAt.set(market, lastMessageAt);

  const { action } = item;
  if (action === "book_clear") {
    for (const key of feedState.keys()) {
      if (key.startsWith(`${data.sportsbook}|`)) feedState.delete(key);
    }
    scheduleBroadcast();
    return;
  }
  if (action === "sport_clear") {
    for (const key of feedState.keys()) {
      if (key.startsWith(`${data.sportsbook}|`)) feedState.delete(key);
    }
    scheduleBroadcast();
    return;
  }

  if (!data.game) return;
  const stateKey = `${data.sportsbook}|${data.game}|${market}`;

  if (action === "game_removed") {
    feedState.delete(stateKey);
    scheduleBroadcast();
    return;
  }

  if (!["initial_state", "game_update", "game_added", "line_update"].includes(action)) {
    return;
  }

  let entry = feedState.get(stateKey);
  if (!entry) {
    entry = {
      sportsbook: data.sportsbook,
      game: data.game,
      market,
      info: data.info || {},
      outcomes: new Map(),
    };
    feedState.set(stateKey, entry);
  }
  if (data.info) entry.info = data.info;
  applyOutcomes(entry, data.outcomes, action !== "line_update");
  scheduleBroadcast();
}

function connectFeed(market = activeMarket) {
  if (!BOLT_KEY) {
    console.error("BOLTODDS_API_KEY is missing. Add it to .env.");
    return;
  }

  activeMarket = market;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (rotationTimer) {
    clearTimeout(rotationTimer);
    rotationTimer = null;
  }

  const socket = new WebSocket(`wss://spro.agency/api?key=${BOLT_KEY}`);
  activeSocket = socket;

  socket.addEventListener("open", () => {
    console.log(`BoltOdds socket opened for ${SPORT} / ${market}`);
  });

  socket.addEventListener("message", async (event) => {
    const raw = typeof event.data === "string" ? event.data : await event.data.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      if (item.action === "socket_connected") {
        socketConnected = true;
        console.log(
          `BoltOdds authenticated (plan: ${item.plan || "unknown"}), subscribing to ${SPORT} / ${market}`,
        );
        socket.send(
          JSON.stringify({
            action: "subscribe",
            filters: {
              sports: [SPORT],
              markets: [market],
              sportsbooks: ALLOWED_SPORTSBOOKS,
            },
          }),
        );
        rotationTimer = setTimeout(() => rotateMarket(socket), MARKET_DWELL_MS);
        scheduleBroadcast();
        continue;
      }
      if (item.action === "ping" || item.action === "subscription_updated") continue;
      if (item.action === "error") {
        console.error("BoltOdds error:", item.message);
        continue;
      }
      handleFeedItem(item, market);
    }
  });

  socket.addEventListener("close", (event) => {
    if (activeSocket === socket) activeSocket = null;
    socketConnected = false;
    scheduleBroadcast();
    console.log(`BoltOdds socket closed (${event.code}) for ${market}`);
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectFeed(activeMarket);
      }, RECONNECT_DELAY_MS);
    }
  });

  socket.addEventListener("error", () => {
    // close event follows and handles the reconnect
  });
}

function rotateMarket(socket) {
  if (socket !== activeSocket) return;
  rotationIndex = (rotationIndex + 1) % ROTATION_MARKETS.length;
  activeMarket = ROTATION_MARKETS[rotationIndex];
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectFeed(activeMarket);
  }, 500);
  try {
    socket.close();
  } catch {
    connectFeed(activeMarket);
  }
}

// ---------------------------------------------------------------------------
// Snapshot for the frontend
// ---------------------------------------------------------------------------

function parseAmerican(price) {
  const value = Number(String(price).replace(/[+−]/g, (match) => (match === "−" ? "-" : "")));
  return Number.isFinite(value) && value !== 0 ? value : null;
}

/** Hide extreme longshots (+1001 and up) from the dashboard. */
const MAX_AMERICAN_ODDS = 1000;

function americanToDecimal(price) {
  const value = parseAmerican(price);
  if (value === null) return null;
  return value > 0 ? 1 + value / 100 : 1 + 100 / Math.abs(value);
}

function probabilityToAmerican(probability) {
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) return null;
  const value =
    probability >= 0.5
      ? -Math.round((probability / (1 - probability)) * 100)
      : Math.round(((1 - probability) / probability) * 100);
  return value > 0 ? `+${value}` : String(value);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalizedSide(side) {
  if (/^(o|over)$/i.test(side || "")) return "Over";
  if (/^(u|under)$/i.test(side || "")) return "Under";
  return side || null;
}

function buildSnapshot() {
  const rawQuotes = [];
  const propQuotes = [];
  const perBookCounts = new Map();

  for (const entry of feedState.values()) {
    const eventName = entry.game.replace(/,\s*[a-f0-9]{12}$/i, "");
    const startsAt = parseWhen(entry.info?.when);

    for (const [outcomeKey, outcome] of entry.outcomes) {
      const category = TARGET_MARKETS.get(outcome.outcome_name || "");
      const american = parseAmerican(outcome.odds);
      const decimal = americanToDecimal(outcome.odds);
      if (!category || !decimal || american === null) continue;
      if (
        isAlternateMarketName(outcome.outcome_name) ||
        isAlternateMarketName(category)
      ) {
        continue;
      }

      const quote = {
        id: `${entry.sportsbook}#${entry.game}#${outcomeKey}`,
        eventKey: entry.game,
        eventId: entry.info?.game_id || entry.game,
        event: eventName,
        startsAt,
        live: Boolean(entry.info?.live || entry.info?.is_live),
        category,
        market: outcome.outcome_name,
        target: outcome.outcome_target || null,
        side: normalizedSide(outcome.outcome_over_under),
        line:
          outcome.outcome_line === null || outcome.outcome_line === ""
            ? null
            : Number(outcome.outcome_line),
        price: outcome.odds,
        decimal,
        american,
        link: outcome.link || entry.info?.link || null,
        sportsbook: { id: entry.sportsbook, name: bookLabel(entry.sportsbook) },
      };

      if (PROP_MARKET_SET.has(category)) {
        propQuotes.push(quote);
        // Also feed player props into EV / arb tables (Over/Under lines).
        if (american <= MAX_AMERICAN_ODDS) {
          rawQuotes.push(quote);
        }
        perBookCounts.set(entry.sportsbook, (perBookCounts.get(entry.sportsbook) || 0) + 1);
        continue;
      }

      if (!GAME_MARKET_SET.has(category) || american > MAX_AMERICAN_ODDS) continue;

      rawQuotes.push(quote);
      perBookCounts.set(entry.sportsbook, (perBookCounts.get(entry.sportsbook) || 0) + 1);
    }
  }

  const marketWidths = new Map();
  for (const quote of rawQuotes) {
    const key = `${quote.eventKey}|${quote.category}|${quote.market}|${quote.target || "game"}`;
    if (!marketWidths.has(key)) {
      marketWidths.set(key, { lines: [], books: new Set() });
    }
    const width = marketWidths.get(key);
    if (Number.isFinite(quote.line)) width.lines.push(quote.line);
    width.books.add(quote.sportsbook.id);
  }

  const overUnderGroups = new Map();
  const spreadGroups = new Map();
  const matchupGroups = new Map();
  for (const quote of rawQuotes) {
    if (quote.side && Number.isFinite(quote.line)) {
      const key = [
        quote.eventKey,
        quote.category,
        quote.market,
        quote.target || "game",
        quote.line,
      ].join("|");
      if (!overUnderGroups.has(key)) overUnderGroups.set(key, []);
      overUnderGroups.get(key).push(quote);
    } else if (Number.isFinite(quote.line) && quote.target) {
      // Pair opposite spread sides at the same absolute line (e.g. -1.5 / +1.5).
      const key = [
        quote.eventKey,
        quote.category,
        quote.market,
        Math.abs(quote.line),
      ].join("|");
      if (!spreadGroups.has(key)) spreadGroups.set(key, []);
      spreadGroups.get(key).push(quote);
    } else {
      if (!quote.target || quote.target === quote.market) continue;
      const key = `${quote.eventKey}|${quote.category}|${quote.market}`;
      if (!matchupGroups.has(key)) matchupGroups.set(key, []);
      matchupGroups.get(key).push(quote);
    }
  }

  const odds = [];

  for (const quotes of overUnderGroups.values()) {
    const sample = quotes[0];
    const byBook = new Map();
    for (const quote of quotes) {
      if (!byBook.has(quote.sportsbook.id)) byBook.set(quote.sportsbook.id, {});
      byBook.get(quote.sportsbook.id)[quote.side] = quote;
    }

    const fairOverByBook = [];
    for (const sides of byBook.values()) {
      if (!sides.Over || !sides.Under) continue;
      const overImplied = 1 / sides.Over.decimal;
      const underImplied = 1 / sides.Under.decimal;
      fairOverByBook.push(overImplied / (overImplied + underImplied));
    }
    const fairOver = median(fairOverByBook);
    if (fairOver === null) continue;

    for (const side of ["Over", "Under"]) {
      const bestByBook = new Map();
      for (const quote of quotes.filter((entry) => entry.side === side)) {
        const existing = bestByBook.get(quote.sportsbook.id);
        if (!existing || quote.decimal > existing.decimal) {
          bestByBook.set(quote.sportsbook.id, quote);
        }
      }
      const sideQuotes = [...bestByBook.values()].sort((a, b) => b.decimal - a.decimal);
      if (!sideQuotes.length) continue;
      const fairProbability = side === "Over" ? fairOver : 1 - fairOver;
      const best = sideQuotes[0];
      const widthKey = `${sample.eventKey}|${sample.category}|${sample.market}|${sample.target || "game"}`;
      const width = marketWidths.get(widthKey);
      const minLine = Math.min(...width.lines);
      const maxLine = Math.max(...width.lines);

      odds.push({
        id: `${sample.eventKey}|${sample.market}|${sample.target || "game"}|${sample.line}|${side}`,
        eventId: sample.eventId,
        event: sample.event,
        startsAt: sample.startsAt,
        live: sample.live,
        category: sample.category,
        market: sample.market,
        name: sample.target || "Match Total",
        side,
        line: sample.line,
        price: best.price,
        sportsbook: best.sportsbook,
        link: best.link,
        fairProbability,
        fairPrice: probabilityToAmerican(fairProbability),
        ev: fairProbability * best.decimal - 1,
        confidenceBooks: fairOverByBook.length,
        bookCount: width.books.size,
        quoteCount: sideQuotes.length,
        lineMin: minLine,
        lineMax: maxLine,
        quotes: sideQuotes.map((quote) => ({
          sportsbook: quote.sportsbook,
          price: quote.price,
          line: quote.line,
          link: quote.link,
        })),
        feedUpdated: lastMessageAt,
      });
    }
  }

  function pushMatchupOdds(quotes) {
    const sample = quotes[0];
    const byBook = new Map();
    for (const quote of quotes) {
      if (!byBook.has(quote.sportsbook.id)) byBook.set(quote.sportsbook.id, []);
      byBook.get(quote.sportsbook.id).push(quote);
    }

    const fairByTarget = new Map();
    for (const bookQuotes of byBook.values()) {
      const uniqueTargets = new Map();
      for (const quote of bookQuotes) {
        const existing = uniqueTargets.get(quote.target);
        if (!existing || quote.decimal > existing.decimal) {
          uniqueTargets.set(quote.target, quote);
        }
      }
      const sides = [...uniqueTargets.values()];
      const impliedTotal = sides.reduce((sum, quote) => sum + 1 / quote.decimal, 0);
      if (sides.length < 2 || !impliedTotal) continue;
      for (const quote of sides) {
        if (!fairByTarget.has(quote.target)) fairByTarget.set(quote.target, []);
        fairByTarget.get(quote.target).push((1 / quote.decimal) / impliedTotal);
      }
    }

    for (const [target, probabilities] of fairByTarget) {
      const bestByBook = new Map();
      for (const quote of quotes.filter((entry) => entry.target === target)) {
        const existing = bestByBook.get(quote.sportsbook.id);
        if (!existing || quote.decimal > existing.decimal) {
          bestByBook.set(quote.sportsbook.id, quote);
        }
      }
      const selectionQuotes = [...bestByBook.values()].sort((a, b) => b.decimal - a.decimal);
      if (!selectionQuotes.length) continue;
      const fairProbability = median(probabilities);
      const best = selectionQuotes[0];
      const widthKey = `${sample.eventKey}|${sample.category}|${sample.market}|${target}`;
      const width = marketWidths.get(widthKey);

      odds.push({
        id: `${sample.eventKey}|${sample.market}|${target}`,
        eventId: sample.eventId,
        event: sample.event,
        startsAt: sample.startsAt,
        live: sample.live,
        category: sample.category,
        market: sample.market,
        name: target,
        side: null,
        line: null,
        price: best.price,
        sportsbook: best.sportsbook,
        link: best.link,
        fairProbability,
        fairPrice: probabilityToAmerican(fairProbability),
        ev: fairProbability * best.decimal - 1,
        confidenceBooks: probabilities.length,
        bookCount: width?.books.size || byBook.size,
        quoteCount: selectionQuotes.length,
        lineMin: null,
        lineMax: null,
        quotes: selectionQuotes.map((quote) => ({
          sportsbook: quote.sportsbook,
          price: quote.price,
          line: quote.line,
          link: quote.link,
        })),
        feedUpdated: lastMessageAt,
      });
    }
  }

  // Spreads must stay on the exact signed line (−5.5 ≠ +5.5).
  function pushSpreadOdds(quotes) {
    const sample = quotes[0];
    const targets = [...new Set(quotes.map((quote) => quote.target).filter(Boolean))];
    if (targets.length !== 2) return;

    const bySelection = new Map();
    for (const quote of quotes) {
      if (!quote.target || !Number.isFinite(quote.line)) continue;
      const key = `${quote.target}|${quote.line}`;
      if (!bySelection.has(key)) bySelection.set(key, []);
      bySelection.get(key).push(quote);
    }

    for (const selectionQuotesRaw of bySelection.values()) {
      const selectionSample = selectionQuotesRaw[0];
      const target = selectionSample.target;
      const line = selectionSample.line;
      const oppositeTarget = targets.find((name) => name !== target);
      const oppositeLine = -line;

      const bestByBook = new Map();
      for (const quote of selectionQuotesRaw) {
        const existing = bestByBook.get(quote.sportsbook.id);
        if (!existing || quote.decimal > existing.decimal) {
          bestByBook.set(quote.sportsbook.id, quote);
        }
      }
      const selectionQuotes = [...bestByBook.values()].sort((a, b) => b.decimal - a.decimal);
      if (!selectionQuotes.length) continue;

      const fairProbs = [];
      const books = new Set(quotes.map((quote) => quote.sportsbook.id));
      for (const bookId of books) {
        const thisSide = selectionQuotesRaw
          .filter((quote) => quote.sportsbook.id === bookId)
          .sort((a, b) => b.decimal - a.decimal)[0];
        const otherSide = quotes
          .filter(
            (quote) =>
              quote.sportsbook.id === bookId &&
              quote.target === oppositeTarget &&
              quote.line === oppositeLine,
          )
          .sort((a, b) => b.decimal - a.decimal)[0];
        if (!thisSide || !otherSide) continue;
        const thisImplied = 1 / thisSide.decimal;
        const otherImplied = 1 / otherSide.decimal;
        fairProbs.push(thisImplied / (thisImplied + otherImplied));
      }
      const fairProbability = median(fairProbs);
      if (fairProbability === null) continue;

      const best = selectionQuotes[0];
      odds.push({
        id: `${sample.eventKey}|${sample.market}|${target}|${line}`,
        eventId: sample.eventId,
        event: sample.event,
        startsAt: sample.startsAt,
        live: sample.live,
        category: sample.category,
        market: sample.market,
        name: target,
        side: null,
        line,
        price: best.price,
        sportsbook: best.sportsbook,
        link: best.link,
        fairProbability,
        fairPrice: probabilityToAmerican(fairProbability),
        ev: fairProbability * best.decimal - 1,
        confidenceBooks: fairProbs.length,
        bookCount: selectionQuotes.length,
        quoteCount: selectionQuotes.length,
        lineMin: line,
        lineMax: line,
        quotes: selectionQuotes.map((quote) => ({
          sportsbook: quote.sportsbook,
          price: quote.price,
          line: quote.line,
          link: quote.link,
        })),
        feedUpdated: lastMessageAt,
      });
    }
  }

  for (const quotes of spreadGroups.values()) {
    pushSpreadOdds(quotes);
  }

  for (const quotes of matchupGroups.values()) {
    pushMatchupOdds(quotes);
  }

  const filtered = dropAlternateSpreads(
    odds,
    findArbs({ overUnderGroups, spreadGroups, matchupGroups }),
  );
  const filteredOdds = filtered.odds;
  const arbs = filtered.arbs;

  filteredOdds.sort(
    (a, b) =>
      b.ev - a.ev ||
      a.event.localeCompare(b.event) ||
      a.category.localeCompare(b.category) ||
      String(a.name).localeCompare(String(b.name)),
  );

  const seenBooks = [...new Set(rawQuotes.map((quote) => quote.sportsbook.id))];
  const feeds = seenBooks.sort().map((id) => ({
    sportsbook: { id, name: bookLabel(id) },
    updated: lastMessageAt,
    count: perBookCounts.get(id) || 0,
    unavailable: false,
    error: undefined,
  }));

  return {
    fetchedAt: new Date().toISOString(),
    feedUpdated: lastMessageAt,
    cached: false,
    connected: socketConnected,
    mode: "rotation",
    activeMarket,
    rotationMarkets: ROTATION_MARKETS,
    marketSyncs: ROTATION_MARKETS.map((market) => ({
      market,
      syncedAt: marketSyncedAt.get(market) || null,
    })),
    methodology:
      "Starter rotation mode: one MLB market is synced per WebSocket connection. Fair + EV + arbs use median no-vig consensus across books (game ML/Spread/Total and batter/pitcher props). Inning markets are live-only and excluded from alerts. Prematch Pythagorean model prices live on the Prematch tab.",
    league: { id: "mlb", name: "MLB", sport: "Baseball" },
    books: feeds.map((feed) => feed.sportsbook),
    selectedBooks: seenBooks,
    rawQuoteCount: rawQuotes.length,
    propQuoteCount: propQuotes.length,
    playerProps: buildPlayerPropIndex(propQuotes),
    odds: filteredOdds,
    arbs,
    feeds,
    pythagorean: pythagWarm
      ? {
          date: pythagWarm.date,
          exponent: pythagWarm.exponent,
          lgAvgRuns: pythagWarm.lgAvgRuns,
          games: pythagWarm.predictions?.length || 0,
        }
      : null,
  };
}

function normalizePlayerKey(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/'/g, "")
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickPropMarketLine(quotes) {
  if (!quotes?.length) return null;
  const byLine = new Map();
  for (const quote of quotes) {
    if (!Number.isFinite(quote.line) || !quote.side) continue;
    if (!byLine.has(quote.line)) byLine.set(quote.line, { Over: null, Under: null });
    const bucket = byLine.get(quote.line);
    const existing = bucket[quote.side];
    if (!existing || quote.decimal > existing.decimal) bucket[quote.side] = quote;
  }
  let best = null;
  for (const [line, sides] of byLine) {
    if (!sides.Over && !sides.Under) continue;
    const primary = sides.Over || sides.Under;
    const both = Boolean(sides.Over && sides.Under);
    const displayable = [sides.Over, sides.Under].some(
      (side) => side && Math.abs(side.american) <= MAX_AMERICAN_ODDS,
    );
    // Prefer two-way lines near even money; fall back to any displayable over.
    const distance = Math.abs((sides.Over || sides.Under).decimal - 2);
    const score =
      (both ? 0 : 100) + (displayable ? 0 : 50) + distance;
    if (!best || score < best.score) {
      best = {
        score,
        line,
        over: sides.Over?.price || "",
        under: sides.Under?.price || "",
        book: primary.sportsbook?.name || primary.sportsbook?.id || "",
      };
    }
  }
  if (!best) return null;
  return {
    line: best.line,
    over: best.over,
    under: best.under,
    book: best.book,
  };
}

function buildPlayerPropIndex(propQuotes) {
  // event -> playerKey -> { name, markets: { [market]: quotes[] } }
  const byEvent = new Map();
  for (const quote of propQuotes) {
    if (!quote.target || !quote.side || !Number.isFinite(quote.line)) continue;
    const playerKey = normalizePlayerKey(quote.target);
    if (!playerKey) continue;
    if (!byEvent.has(quote.event)) {
      byEvent.set(quote.event, { byKey: new Map(), byLast: new Map() });
    }
    const eventIndex = byEvent.get(quote.event);
    if (!eventIndex.byKey.has(playerKey)) {
      eventIndex.byKey.set(playerKey, {
        name: quote.target,
        markets: new Map(),
      });
      const last = playerKey.split(" ").pop();
      if (!eventIndex.byLast.has(last)) eventIndex.byLast.set(last, []);
      eventIndex.byLast.get(last).push(playerKey);
    }
    const player = eventIndex.byKey.get(playerKey);
    if (!player.markets.has(quote.market)) player.markets.set(quote.market, []);
    player.markets.get(quote.market).push(quote);
  }

  const boards = new Map();
  for (const [event, eventIndex] of byEvent) {
    const players = new Map();
    for (const [playerKey, player] of eventIndex.byKey) {
      const markets = {};
      for (const [market, quotes] of player.markets) {
        const picked = pickPropMarketLine(quotes);
        if (picked) markets[market] = picked;
      }
      players.set(playerKey, { name: player.name, markets });
    }
    boards.set(event, { players, byLast: eventIndex.byLast });
  }
  return boards;
}

function findPlayerPropEntry(eventBoard, playerName) {
  if (!eventBoard || !playerName) return null;
  const key = normalizePlayerKey(playerName);
  if (!key) return null;
  if (eventBoard.players.has(key)) return eventBoard.players.get(key);

  const parts = key.split(" ").filter(Boolean);
  const last = parts[parts.length - 1];
  const candidates = eventBoard.byLast.get(last) || [];
  if (candidates.length === 1) return eventBoard.players.get(candidates[0]);

  if (parts.length >= 2) {
    const first = parts[0];
    const hit = candidates.find((candidateKey) => {
      const candParts = candidateKey.split(" ");
      return candParts[0] === first || candParts[0]?.[0] === first[0];
    });
    if (hit) return eventBoard.players.get(hit);
  }

  for (const [candidateKey, entry] of eventBoard.players) {
    if (candidateKey.includes(key) || key.includes(candidateKey)) return entry;
  }
  return null;
}

function propsForPlayer(eventBoard, playerName, specs) {
  const entry = findPlayerPropEntry(eventBoard, playerName);
  const out = {};
  for (const spec of specs) {
    const picked = entry?.markets?.[spec.market] || null;
    out[`${spec.prefix}_line`] = picked?.line ?? "";
    out[`${spec.prefix}_over`] = picked?.over || "";
    out[`${spec.prefix}_under`] = picked?.under || "";
    out[`${spec.prefix}_book`] = picked?.book || "";
  }
  return out;
}

function summarizePlayerProps(eventName, batterName, pitcherName, propBoards = null) {
  if (!eventName) {
    return {
      ...propsForPlayer(null, "", BATTER_PROP_SPECS),
      ...propsForPlayer(null, "", PITCHER_PROP_SPECS),
    };
  }
  let board = null;
  if (propBoards) {
    board = propBoards.get(eventName) || null;
  } else {
    try {
      board = buildSnapshot().playerProps?.get(eventName) || null;
    } catch {
      board = null;
    }
  }
  return {
    ...propsForPlayer(board, batterName, BATTER_PROP_SPECS),
    ...propsForPlayer(board, pitcherName, PITCHER_PROP_SPECS),
  };
}

// Two-way arb: best price on each side where 1/d1 + 1/d2 < 1.
// Only count cross-book arbs (different sportsbooks on each leg).
function findArbs({ overUnderGroups, spreadGroups, matchupGroups }) {
  const arbs = [];

  function bestCrossBookPair(sidePools, { requireOppositeSpread = false } = {}) {
    if (sidePools.length !== 2) return null;
    const [poolA, poolB] = sidePools.map((pool) =>
      [...pool].sort((a, b) => b.decimal - a.decimal),
    );
    let best = null;
    for (const quoteA of poolA) {
      for (const quoteB of poolB) {
        if (quoteA.sportsbook.id === quoteB.sportsbook.id) continue;
        if (requireOppositeSpread) {
          // Must be opposite teams AND opposite signs (e.g. -5.5 vs +5.5).
          if (!quoteA.target || !quoteB.target || quoteA.target === quoteB.target) continue;
          if (
            !Number.isFinite(quoteA.line) ||
            !Number.isFinite(quoteB.line) ||
            quoteA.line * quoteB.line >= 0 ||
            Math.abs(quoteA.line) !== Math.abs(quoteB.line)
          ) {
            continue;
          }
        }
        const impliedSum = 1 / quoteA.decimal + 1 / quoteB.decimal;
        if (!(impliedSum > 0 && impliedSum < 1)) continue;
        if (!best || impliedSum < best.impliedSum) {
          best = { sides: [quoteA, quoteB], impliedSum };
        }
        break; // poolB is sorted best-first; first valid partner is best for this A
      }
    }
    return best;
  }

  function consider(sidePools, meta, options) {
    const pair = bestCrossBookPair(sidePools, options);
    if (!pair) return;

    const profit = 1 / pair.impliedSum - 1;
    const totalStake = 100;
    const legs = pair.sides.map((side) => {
      const stake = ((1 / side.decimal) / pair.impliedSum) * totalStake;
      return {
        name: side.name,
        target: side.target || side.name,
        side: side.side || null,
        line: side.line ?? null,
        price: side.price,
        decimal: side.decimal,
        stake: Math.round(stake * 100) / 100,
        sportsbook: side.sportsbook,
        link: side.link,
      };
    });

    arbs.push({
      id: meta.id,
      event: meta.event,
      eventId: meta.eventId,
      startsAt: meta.startsAt,
      live: meta.live,
      category: meta.category,
      market: meta.market,
      line: meta.line ?? null,
      impliedSum: pair.impliedSum,
      profit,
      totalStake,
      payout: Math.round(totalStake * (1 / pair.impliedSum) * 100) / 100,
      legs,
      feedUpdated: lastMessageAt,
    });
  }

  for (const quotes of overUnderGroups.values()) {
    const sample = quotes[0];
    const pools = { Over: [], Under: [] };
    for (const quote of quotes) {
      if (!pools[quote.side]) continue;
      pools[quote.side].push({
        name: quote.target
          ? `${quote.target} ${quote.side} ${quote.line}`
          : `${quote.side} ${quote.line}`,
        target: quote.target || "game",
        side: quote.side,
        line: quote.line,
        price: quote.price,
        decimal: quote.decimal,
        sportsbook: quote.sportsbook,
        link: quote.link,
      });
    }
    if (!pools.Over.length || !pools.Under.length) continue;
    consider([pools.Over, pools.Under], {
      id: `${sample.eventKey}|${sample.market}|${sample.target || "game"}|${sample.line}|arb`,
      event: sample.event,
      eventId: sample.eventId,
      startsAt: sample.startsAt,
      live: sample.live,
      category: sample.category,
      market: sample.market,
      line: sample.line,
    });
  }

  // Spreads: only pair opposite signs at the same absolute line (−1.5 vs +1.5).
  for (const quotes of spreadGroups.values()) {
    const sample = quotes[0];
    const favorites = [];
    const dogs = [];
    for (const quote of quotes) {
      if (!quote.target || !Number.isFinite(quote.line) || quote.line === 0) continue;
      const entry = {
        name: quote.target,
        target: quote.target,
        side: null,
        line: quote.line,
        price: quote.price,
        decimal: quote.decimal,
        sportsbook: quote.sportsbook,
        link: quote.link,
      };
      if (quote.line < 0) favorites.push(entry);
      else dogs.push(entry);
    }
    if (!favorites.length || !dogs.length) continue;
    const absLine = Math.abs(
      favorites[0]?.line ?? dogs[0]?.line ?? sample.line,
    );
    consider(
      [favorites, dogs],
      {
        id: `${sample.eventKey}|${sample.market}|${absLine}|arb`,
        event: sample.event,
        eventId: sample.eventId,
        startsAt: sample.startsAt,
        live: sample.live,
        category: sample.category,
        market: sample.market,
        line: absLine,
      },
      { requireOppositeSpread: true },
    );
  }

  // Moneylines: two different teams, no line.
  for (const quotes of matchupGroups.values()) {
    const sample = quotes[0];
    const byTarget = new Map();
    for (const quote of quotes) {
      if (!quote.target) continue;
      if (!byTarget.has(quote.target)) byTarget.set(quote.target, []);
      byTarget.get(quote.target).push({
        name: quote.target,
        target: quote.target,
        side: null,
        line: null,
        price: quote.price,
        decimal: quote.decimal,
        sportsbook: quote.sportsbook,
        link: quote.link,
      });
    }
    const targets = [...byTarget.keys()];
    if (targets.length !== 2) continue;
    consider(
      targets.map((target) => byTarget.get(target)),
      {
        id: `${sample.eventKey}|${sample.market}|ml|arb`,
        event: sample.event,
        eventId: sample.eventId,
        startsAt: sample.startsAt,
        live: sample.live,
        category: sample.category,
        market: sample.market,
        line: null,
      },
    );
  }

  arbs.sort((a, b) => b.profit - a.profit || a.event.localeCompare(b.event));
  return arbs;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function teamsLooseMatch(a, b) {
  const left = String(a || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const right = String(b || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!left || !right) return false;
  return left.includes(right) || right.includes(left);
}

function mostCommonLine(values) {
  const counts = new Map();
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  let best = null;
  let bestCount = -1;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function quotesByBook(row) {
  const out = {};
  for (const quote of row?.quotes || []) {
    const id = quote.sportsbook?.id;
    if (!id) continue;
    out[id] = {
      price: quote.price ?? "",
      line: quote.line ?? null,
      book: quote.sportsbook?.name || id,
    };
  }
  return out;
}

function compactOddSide(row) {
  if (!row) return null;
  return {
    name: row.name || null,
    side: row.side || null,
    line: row.line ?? null,
    price: row.price,
    book: row.sportsbook?.name || row.sportsbook?.id || "",
    fairPrice: row.fairPrice ?? null,
    fairProbability: Number.isFinite(row.fairProbability) ? row.fairProbability : null,
    ev: Number.isFinite(row.ev) ? row.ev : null,
    byBook: quotesByBook(row),
  };
}

function summarizeLiveOddsBoard(eventName, awayName, homeName) {
  if (!eventName) return null;
  let rows = [];
  try {
    rows = (buildSnapshot().odds || []).filter((row) => row.event === eventName);
  } catch {
    return null;
  }
  if (!rows.length) return null;

  const moneyline = rows.filter((row) => row.category === "Moneyline");
  const spreads = rows.filter((row) => row.category === "Spread");
  const totals = rows.filter((row) => row.category === "Total");

  const awayMl =
    moneyline.find((row) => teamsLooseMatch(row.name, awayName)) || null;
  const homeMl =
    moneyline.find((row) => teamsLooseMatch(row.name, homeName)) || null;

  const preferredSpread = mostCommonLine(
    spreads.map((row) => Math.abs(Number(row.line))).filter(Number.isFinite),
  );
  const spreadPool = Number.isFinite(preferredSpread)
    ? spreads.filter((row) => Math.abs(Number(row.line)) === preferredSpread)
    : spreads;
  const awaySpread =
    spreadPool.find((row) => teamsLooseMatch(row.name, awayName)) || null;
  const homeSpread =
    spreadPool.find((row) => teamsLooseMatch(row.name, homeName)) || null;

  const preferredTotal = mostCommonLine(
    totals.map((row) => Number(row.line)).filter(Number.isFinite),
  );
  const totalPool = Number.isFinite(preferredTotal)
    ? totals.filter((row) => Number(row.line) === preferredTotal)
    : totals;
  const over = totalPool.find((row) => row.side === "Over") || null;
  const under = totalPool.find((row) => row.side === "Under") || null;

  return {
    event: eventName,
    updatedAt: lastMessageAt,
    markets: ["Moneyline", "Spread", "Total"],
    sportsbooks: [...ALLOWED_SPORTSBOOKS],
    moneyline: {
      away: compactOddSide(awayMl),
      home: compactOddSide(homeMl),
    },
    spread: {
      line: preferredSpread ?? null,
      away: compactOddSide(awaySpread),
      home: compactOddSide(homeSpread),
    },
    total: {
      line: preferredTotal ?? null,
      over: compactOddSide(over),
      under: compactOddSide(under),
    },
  };
}

function summarizeInningBookSides(eventName, awayName, homeName) {
  if (!eventName) return {};
  let rows = [];
  try {
    rows = (buildSnapshot().odds || []).filter((row) => row.event === eventName);
  } catch {
    return {};
  }
  const byInning = {};
  for (let n = 1; n <= 9; n += 1) {
    const mlName = inningMarketName(n, "Moneyline");
    const spName = inningMarketName(n, "Spread");
    const totName = inningMarketName(n, "Total");
    const ml = rows.filter((row) => row.category === mlName || row.market === mlName);
    const spreads = rows.filter((row) => row.category === spName || row.market === spName);
    const totals = rows.filter((row) => row.category === totName || row.market === totName);

    const awayMl =
      ml.find((row) => teamsLooseMatch(row.name, awayName)) || null;
    const homeMl =
      ml.find((row) => teamsLooseMatch(row.name, homeName)) || null;
    const preferredSpread = mostCommonLine(
      spreads.map((row) => Math.abs(Number(row.line))).filter(Number.isFinite),
    );
    const spreadPool = Number.isFinite(preferredSpread)
      ? spreads.filter((row) => Math.abs(Number(row.line)) === preferredSpread)
      : spreads;
    const awaySpread =
      spreadPool.find((row) => teamsLooseMatch(row.name, awayName)) || null;
    const homeSpread =
      spreadPool.find((row) => teamsLooseMatch(row.name, homeName)) || null;
    const preferredTotal = mostCommonLine(
      totals.map((row) => Number(row.line)).filter(Number.isFinite),
    );
    const totalPool = Number.isFinite(preferredTotal)
      ? totals.filter((row) => Number(row.line) === preferredTotal)
      : totals;
    const over = totalPool.find((row) => row.side === "Over") || null;
    const under = totalPool.find((row) => row.side === "Under") || null;

    byInning[n] = {
      awayMl: awayMl?.price || "",
      homeMl: homeMl?.price || "",
      awayMlBook: awayMl?.sportsbook?.name || "",
      homeMlBook: homeMl?.sportsbook?.name || "",
      spreadAbs: preferredSpread ?? 0.5,
      awaySpread: awaySpread?.price || "",
      homeSpread: homeSpread?.price || "",
      awaySpreadBook: awaySpread?.sportsbook?.name || "",
      homeSpreadBook: homeSpread?.sportsbook?.name || "",
      totalLine: preferredTotal ?? 0.5,
      over: over?.price || "",
      under: under?.price || "",
      overBook: over?.sportsbook?.name || "",
      underBook: under?.sportsbook?.name || "",
    };
  }
  return byInning;
}

function bookPrice(side, bookId) {
  return side?.byBook?.[bookId]?.price ?? "";
}

function bookLine(side, bookId) {
  const value = side?.byBook?.[bookId]?.line;
  return value == null || value === "" ? "" : value;
}

function emptyPropColumns() {
  const row = {};
  for (const spec of [...BATTER_PROP_SPECS, ...PITCHER_PROP_SPECS]) {
    row[`${spec.prefix}_line`] = "";
    row[`${spec.prefix}_over`] = "";
    row[`${spec.prefix}_under`] = "";
    row[`${spec.prefix}_book`] = "";
  }
  return row;
}

function flattenPlayRow(play, game, index, { isLatest = false } = {}) {
  const odds = play.odds || null;
  const props = play.props || emptyPropColumns();
  const awayAbbr = game.away?.abbreviation || "AWAY";
  const homeAbbr = game.home?.abbreviation || "HOME";
  const row = {
    play_n: index + 1,
    play_id: play.id || `${play.text}:${play.period}:${play.clock}`,
    inning: play.period || "",
    clock: play.clock || "",
    type: play.type || "",
    text: play.text || "",
    batter: play.batter || "",
    pitcher: play.pitcher || "",
    scoring_play: play.scoringPlay ? 1 : 0,
    away_abbr: awayAbbr,
    home_abbr: homeAbbr,
    away_score: play.awayScore ?? play.gameState?.awayScore ?? "",
    home_score: play.homeScore ?? play.gameState?.homeScore ?? "",
    ...props,
    // Best price + book, then market consensus (BoltOdds consensus, else no-vig fair).
    away_ml_best: odds?.moneyline?.away?.price ?? "",
    away_ml_best_book: odds?.moneyline?.away?.book ?? "",
    away_ml_consensus:
      bookPrice(odds?.moneyline?.away, "consensus") ||
      odds?.moneyline?.away?.fairPrice ||
      "",
    home_ml_best: odds?.moneyline?.home?.price ?? "",
    home_ml_best_book: odds?.moneyline?.home?.book ?? "",
    home_ml_consensus:
      bookPrice(odds?.moneyline?.home, "consensus") ||
      odds?.moneyline?.home?.fairPrice ||
      "",
    spread_line: odds?.spread?.line ?? "",
    away_spread_best: odds?.spread?.away?.price ?? "",
    away_spread_best_book: odds?.spread?.away?.book ?? "",
    away_spread_consensus:
      bookPrice(odds?.spread?.away, "consensus") ||
      odds?.spread?.away?.fairPrice ||
      "",
    home_spread_best: odds?.spread?.home?.price ?? "",
    home_spread_best_book: odds?.spread?.home?.book ?? "",
    home_spread_consensus:
      bookPrice(odds?.spread?.home, "consensus") ||
      odds?.spread?.home?.fairPrice ||
      "",
    total_line: odds?.total?.line ?? odds?.total?.over?.line ?? "",
    over_best: odds?.total?.over?.price ?? "",
    over_best_book: odds?.total?.over?.book ?? "",
    over_consensus:
      bookPrice(odds?.total?.over, "consensus") ||
      odds?.total?.over?.fairPrice ||
      "",
    under_best: odds?.total?.under?.price ?? "",
    under_best_book: odds?.total?.under?.book ?? "",
    under_consensus:
      bookPrice(odds?.total?.under, "consensus") ||
      odds?.total?.under?.fairPrice ||
      "",
  };

  for (const book of ALLOWED_SPORTSBOOKS) {
    if (book === "consensus") continue; // surfaced as *_consensus columns above
    row[`ml_away_${book}`] = bookPrice(odds?.moneyline?.away, book);
    row[`ml_home_${book}`] = bookPrice(odds?.moneyline?.home, book);
    row[`spread_away_line_${book}`] = bookLine(odds?.spread?.away, book);
    row[`spread_away_${book}`] = bookPrice(odds?.spread?.away, book);
    row[`spread_home_line_${book}`] = bookLine(odds?.spread?.home, book);
    row[`spread_home_${book}`] = bookPrice(odds?.spread?.home, book);
    row[`over_${book}`] = bookPrice(odds?.total?.over, book);
    row[`under_${book}`] = bookPrice(odds?.total?.under, book);
  }

  row.odds_event = odds?.event || game.matchedEvent || "";
  row.odds_stamped_at = odds?.stampedAt || "";
  row.is_latest = isLatest ? 1 : 0;
  return row;
}

function buildPlayFrameColumns() {
  // Keep game odds near the left edge: context → batter/pitcher → ML/spread/total → score → props.
  const columns = [
    "play_n",
    "inning",
    "type",
    "batter",
    "pitcher",
    "away_ml_best",
    "away_ml_best_book",
    "away_ml_consensus",
    "home_ml_best",
    "home_ml_best_book",
    "home_ml_consensus",
    "spread_line",
    "away_spread_best",
    "away_spread_best_book",
    "away_spread_consensus",
    "home_spread_best",
    "home_spread_best_book",
    "home_spread_consensus",
    "total_line",
    "over_best",
    "over_best_book",
    "over_consensus",
    "under_best",
    "under_best_book",
    "under_consensus",
    "text",
    "away_abbr",
    "home_abbr",
    "away_score",
    "home_score",
    "scoring_play",
    ...BATTER_PROP_SPECS.flatMap((spec) => [
      `${spec.prefix}_line`,
      `${spec.prefix}_over`,
      `${spec.prefix}_under`,
      `${spec.prefix}_book`,
    ]),
    ...PITCHER_PROP_SPECS.flatMap((spec) => [
      `${spec.prefix}_line`,
      `${spec.prefix}_over`,
      `${spec.prefix}_under`,
      `${spec.prefix}_book`,
    ]),
  ];
  for (const book of ALLOWED_SPORTSBOOKS) {
    if (book === "consensus") continue;
    columns.push(
      `ml_away_${book}`,
      `ml_home_${book}`,
      `spread_away_line_${book}`,
      `spread_away_${book}`,
      `spread_home_line_${book}`,
      `spread_home_${book}`,
      `over_${book}`,
      `under_${book}`,
    );
  }
  columns.push(
    "clock",
    "play_id",
    "odds_event",
    "odds_stamped_at",
    "is_latest",
  );
  return columns;
}

const PLAY_FRAME_COLUMNS = buildPlayFrameColumns();

function attachBookQuotes(stamped, live) {
  if (!stamped) return live;
  if (!live) return stamped;
  const mergeSide = (side, liveSide) => {
    if (!side) return liveSide || null;
    if (side.byBook && Object.keys(side.byBook).length) return side;
    return {
      ...side,
      byBook: liveSide?.byBook || {},
    };
  };
  return {
    ...stamped,
    markets: stamped.markets || live.markets || ["Moneyline", "Spread", "Total"],
    sportsbooks: stamped.sportsbooks || live.sportsbooks || [...ALLOWED_SPORTSBOOKS],
    moneyline: {
      away: mergeSide(stamped.moneyline?.away, live.moneyline?.away),
      home: mergeSide(stamped.moneyline?.home, live.moneyline?.home),
    },
    spread: {
      line: stamped.spread?.line ?? live.spread?.line ?? null,
      away: mergeSide(stamped.spread?.away, live.spread?.away),
      home: mergeSide(stamped.spread?.home, live.spread?.home),
    },
    total: {
      line: stamped.total?.line ?? live.total?.line ?? null,
      over: mergeSide(stamped.total?.over, live.total?.over),
      under: mergeSide(stamped.total?.under, live.total?.under),
    },
  };
}

function booksFromLiveOdds(liveOdds) {
  if (!liveOdds) return {};
  return {
    awayMl: liveOdds.moneyline?.away?.price,
    awayMlBook: liveOdds.moneyline?.away?.book,
    homeMl: liveOdds.moneyline?.home?.price,
    homeMlBook: liveOdds.moneyline?.home?.book,
    awaySpread: liveOdds.spread?.away?.price,
    awaySpreadBook: liveOdds.spread?.away?.book,
    homeSpread: liveOdds.spread?.home?.price,
    homeSpreadBook: liveOdds.spread?.home?.book,
    spreadAbs: liveOdds.spread?.line,
    over: liveOdds.total?.over?.price,
    overBook: liveOdds.total?.over?.book,
    under: liveOdds.total?.under?.price,
    underBook: liveOdds.total?.under?.book,
    totalLine: liveOdds.total?.line,
  };
}

function parseEventTeams(eventName) {
  // Strip trailing ", YYYY-MM-DD" BoltOdds suffixes.
  const s = String(eventName || "")
    .replace(/,\s*\d{4}-\d{2}-\d{2}.*$/, "")
    .trim();
  if (/\s+@\s+/.test(s)) {
    const parts = s.split(/\s+@\s+/);
    if (parts.length !== 2) return null;
    // "Away @ Home"
    return { away: parts[0].trim(), home: parts[1].trim() };
  }
  if (/\s+vs\.?\s+/i.test(s)) {
    const parts = s.split(/\s+vs\.?\s+/i);
    if (parts.length !== 2) return null;
    // BoltOdds MLB lists "Home vs Away"
    return { home: parts[0].trim(), away: parts[1].trim() };
  }
  return null;
}

function eventMatchesPrediction(eventName, pred) {
  if (!pred) return false;
  const teams = parseEventTeams(eventName);
  if (teams) {
    const a = normalizeLoose(teams.away);
    const h = normalizeLoose(teams.home);
    const pa = normalizeLoose(pred.awayTeam);
    const ph = normalizeLoose(pred.homeTeam);
    if ((a === pa || a.includes(pa) || pa.includes(a)) && (h === ph || h.includes(ph) || ph.includes(h))) {
      return true;
    }
    // tolerate swapped parse
    if ((a === ph || a.includes(ph) || ph.includes(a)) && (h === pa || h.includes(pa) || pa.includes(h))) {
      return true;
    }
  }
  const blob = normalizeLoose(eventName);
  return (
    blob.includes(normalizeLoose(pred.awayTeam)) &&
    blob.includes(normalizeLoose(pred.homeTeam))
  );
}

function normalizeLoose(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

let pythagWarm = null;

async function refreshPythagCache() {
  try {
    pythagWarm = await buildPrematchPredictions();
    console.log(
      `Pythagorean prematch ready: ${pythagWarm.predictions?.length || 0} games · exp=${pythagWarm.exponent}`,
    );
  } catch (error) {
    console.warn(`Pythagorean refresh failed: ${error.message || error}`);
  }
}

function applyPythagoreanToOdds(odds) {
  // Intentionally a no-op for the odds snapshot / +EV tab.
  // Fair + EV must stay on market consensus. Pythagorean model prices are
  // only served via /api/predictions for the Prematch tab.
  return odds;
}

async function enrichGameDetailWithOdds(detail) {
  if (!detail?.game) return detail;

  const matchedEvent = detail.game.matchedEvent || null;
  const awayName = detail.game.away?.name || "";
  const homeName = detail.game.home?.name || "";
  const liveOdds = summarizeLiveOddsBoard(matchedEvent, awayName, homeName);
  const inningBooks = summarizeInningBookSides(matchedEvent, awayName, homeName);
  const inningModel = detail.situation
    ? buildInningModelBoard(detail.situation, inningBooks)
    : null;

  let pythagModel = null;
  try {
    if (!pythagWarm) await refreshPythagCache();
    const pred = findPredictionForMatchup(awayName, homeName, pythagWarm);
    if (pred) {
      pythagModel = enrichWithBooks(pred, booksFromLiveOdds(liveOdds));
    }
  } catch {
    pythagModel = null;
  }

  let propBoards = null;
  try {
    propBoards = buildSnapshot().playerProps || null;
  } catch {
    propBoards = null;
  }

  const gameState = {
    awayScore: detail.game.away?.score ?? null,
    homeScore: detail.game.home?.score ?? null,
    awayAbbr: detail.game.away?.abbreviation || "AWAY",
    homeAbbr: detail.game.home?.abbreviation || "HOME",
    status: detail.game.status || null,
    situation: detail.situation || null,
  };

  const plays = (detail.plays || []).map((play) => {
    const playId = String(
      play.id || `${play.text}:${play.period}:${play.clock}`,
    );
    const key = `${detail.game.id}|${playId}`;
    if (liveOdds && !playOddsMemory.has(key)) {
      playOddsMemory.set(key, {
        ...liveOdds,
        stampedAt: new Date().toISOString(),
      });
    }
    const stamped = playOddsMemory.get(key) || liveOdds;
    const propKey = `${key}|props`;
    if (!playOddsMemory.has(propKey)) {
      playOddsMemory.set(propKey, {
        ...summarizePlayerProps(matchedEvent, play.batter, play.pitcher, propBoards),
        stampedAt: new Date().toISOString(),
      });
    }
    const liveProps = summarizePlayerProps(
      matchedEvent,
      play.batter,
      play.pitcher,
      propBoards,
    );
    const stampedProps = playOddsMemory.get(propKey) || liveProps;
    const props = { ...liveProps };
    for (const [field, value] of Object.entries(stampedProps)) {
      if (field === "stampedAt") continue;
      if (value !== "" && value != null) props[field] = value;
    }
    return {
      ...play,
      gameState: {
        awayScore: play.awayScore ?? gameState.awayScore,
        homeScore: play.homeScore ?? gameState.homeScore,
        period: play.period || gameState.status?.shortDetail || "",
        clock: play.clock || "",
      },
      odds: attachBookQuotes(stamped, liveOdds),
      props,
    };
  });

  if (playOddsMemory.size > 20_000) {
    for (const key of [...playOddsMemory.keys()].slice(0, 5_000)) {
      playOddsMemory.delete(key);
    }
  }

  const dataframe = {
    columns: PLAY_FRAME_COLUMNS,
    rows: plays.map((play, index) =>
      flattenPlayRow(play, detail.game, index, {
        isLatest: index === plays.length - 1,
      }),
    ),
  };

  return {
    ...detail,
    gameState,
    liveOdds,
    inningModel,
    pythagModel,
    plays,
    dataframe,
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function serveStatic(requestPath, response) {
  const requested = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  const extension = path.extname(filePath);
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
  };
  response.writeHead(200, {
    "Content-Type": contentTypes[extension] || "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (url.pathname === "/api/stream") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    response.write(`event: connected\ndata: ${JSON.stringify({ connected: socketConnected })}\n\n`);
    streamClients.add(response);
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    request.on("close", () => {
      clearInterval(heartbeat);
      streamClients.delete(response);
    });
    return;
  }

  if (url.pathname === "/api/odds") {
    if (!BOLT_KEY) {
      sendJson(response, 500, {
        error: "BOLTODDS_API_KEY is missing. Add it to .env.",
      });
      return;
    }
    sendJson(response, 200, buildSnapshot());
    return;
  }

  if (url.pathname === "/api/predictions") {
    buildPrematchPredictions()
      .then((cache) => {
        pythagWarm = cache;
        const oddsByEvent = new Map();
        try {
          for (const odd of buildSnapshot().odds || []) {
            if (odd.live) continue;
            if (!["Moneyline", "Spread", "Total"].includes(odd.category)) continue;
            if (!oddsByEvent.has(odd.event)) oddsByEvent.set(odd.event, []);
            oddsByEvent.get(odd.event).push(odd);
          }
        } catch {
          /* feed may be empty */
        }
        const games = (cache.predictions || []).map((pred) => {
          const eventKey =
            [...oddsByEvent.keys()].find((ev) => eventMatchesPrediction(ev, pred)) ||
            null;
          const liveOdds = eventKey
            ? summarizeLiveOddsBoard(eventKey, pred.awayTeam, pred.homeTeam)
            : null;
          return enrichWithBooks(pred, booksFromLiveOdds(liveOdds));
        });
        sendJson(response, 200, {
          date: cache.date,
          exponent: cache.exponent,
          lgAvgRuns: cache.lgAvgRuns,
          methodology:
            "Projected runs (Pythagorean OS/DS + pitcher/L20/HFA) → Skellam ML & spread + Poisson total fair prices vs BoltOdds. EV = model_prob × book_decimal − 1.",
          games,
        });
      })
      .catch((error) =>
        sendJson(response, 502, {
          error: error.message || "Pythagorean predictions unavailable",
        }),
      );
    return;
  }

  if (url.pathname === "/api/live") {
    buildLiveBoard(collectOddsEventNames())
      .then((board) => sendJson(response, 200, board))
      .catch((error) =>
        sendJson(response, 502, { error: error.message || "ESPN live board unavailable" }),
      );
    return;
  }

  const liveMatch = url.pathname.match(/^\/api\/live\/([^/]+)$/);
  if (liveMatch) {
    buildGameDetail(decodeURIComponent(liveMatch[1]), collectOddsEventNames())
      .then((detail) => enrichGameDetailWithOdds(detail))
      .then((detail) => sendJson(response, 200, detail))
      .catch((error) =>
        sendJson(response, 502, { error: error.message || "ESPN game detail unavailable" }),
      );
    return;
  }

  if (request.method !== "GET") {
    response.writeHead(405, { Allow: "GET" });
    response.end("Method not allowed");
    return;
  }
  serveStatic(decodeURIComponent(url.pathname), response);
});

function collectOddsEventNames() {
  try {
    return [...new Set((buildSnapshot().odds || []).map((odd) => odd.event).filter(Boolean))];
  } catch {
    return [];
  }
}

server.listen(PORT, () => {
  console.log(`mlb_pbp_model is running at http://localhost:${PORT}`);
  if (telegramConfigured()) {
    console.log(
      "Telegram alerts enabled (+EV / arb). Run npm run telegram:test to verify.",
    );
  }
  connectFeed();
  refreshPythagCache();
  setInterval(refreshPythagCache, 10 * 60 * 1000);
});
