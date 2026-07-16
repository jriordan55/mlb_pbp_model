const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { buildLiveBoard, buildGameDetail } = require("./espn");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
loadEnv(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT) || 3000;
const BOLT_KEY = process.env.BOLTODDS_API_KEY;
const RECONNECT_DELAY_MS = 5_000;
const MARKET_DWELL_MS = 6_000;

const SPORT = "MLB";
const ROTATION_MARKETS = ["Moneyline", "Spread", "Total"];
const TARGET_MARKETS = new Map(
  ROTATION_MARKETS.map((market) => [market, market]),
);

// Only these books are subscribed and retained. "fanatics" is included in case
// BoltOdds adds it later — it is not currently in their sportsbook list.
const ALLOWED_SPORTSBOOKS = [
  "draftkings",
  "fanduel",
  "betmgm",
  "thescore",
  "fanatics",
  "polymarket",
  "kalshi",
  "caesars",
  "prophetx",
  "novig",
];

const BOOK_LABELS = {
  draftkings: "DraftKings",
  fanduel: "FanDuel",
  betmgm: "BetMGM",
  thescore: "theScore",
  fanatics: "Fanatics",
  polymarket: "Polymarket",
  kalshi: "Kalshi",
  caesars: "Caesars",
  prophetx: "ProphetX",
  novig: "Novig",
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
let socketConnected = false;
let lastMessageAt = null;
let broadcastTimer = null;
let rotationIndex = 0;
let activeMarket = ROTATION_MARKETS[0];
let activeSocket = null;
let reconnectTimer = null;
let rotationTimer = null;

// Throttled so the browser re-renders at most every 2s, letting the row
// flash animation (1.4s) finish before the next update replaces the rows.
function scheduleBroadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const message = `event: update\ndata: ${JSON.stringify({ updated: lastMessageAt })}\n\n`;
    for (const client of streamClients) client.write(message);
  }, 2000);
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

function americanToDecimal(price) {
  const value = Number(String(price).replace(/[+−]/g, (match) => (match === "−" ? "-" : "")));
  if (!Number.isFinite(value) || value === 0) return null;
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
  const perBookCounts = new Map();

  for (const entry of feedState.values()) {
    const eventName = entry.game.replace(/,\s*[a-f0-9]{12}$/i, "");
    const startsAt = parseWhen(entry.info?.when);

    for (const [outcomeKey, outcome] of entry.outcomes) {
      const category = TARGET_MARKETS.get(outcome.outcome_name || "");
      const decimal = americanToDecimal(outcome.odds);
      if (!category || !decimal) continue;

      rawQuotes.push({
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
        link: outcome.link || entry.info?.link || null,
        sportsbook: { id: entry.sportsbook, name: bookLabel(entry.sportsbook) },
      });
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

  const arbs = findArbs({ overUnderGroups, spreadGroups, matchupGroups });

  odds.sort(
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
      "Starter rotation mode: one MLB market is synced per WebSocket connection. EV uses the median no-vig probability from sportsbooks offering both sides at the same line (or absolute spread). Arbs use the best available price on each side.",
    league: { id: "mlb", name: "MLB", sport: "Baseball" },
    books: feeds.map((feed) => feed.sportsbook),
    selectedBooks: seenBooks,
    rawQuoteCount: rawQuotes.length,
    odds,
    arbs,
    feeds,
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
        name: `${quote.side} ${quote.line}`,
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
  connectFeed();
});
