#!/usr/bin/env node
/**
 * Build a static GitHub Pages site from public/ + live ESPN + Pythag + scraped odds.
 * Output: site/  (uploaded by .github/workflows/pages.yml)
 */

const fs = require("fs");
const path = require("path");

const { buildLiveBoard, buildGameDetail } = require("./espn");
const { buildPrematchPredictions, enrichWithBooks } = require("./pythag/mlb_stats");
const { findValueFromOddsRows } = require("./odds_value");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const OUT_DIR = path.join(ROOT, "site");
const DATA_PATHS = [
  path.join(ROOT, "data", "latest.json"),
  process.env.SCRAPER_DATA_DIR
    ? path.join(process.env.SCRAPER_DATA_DIR, "latest.json")
    : null,
].filter(Boolean);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data));
}

function copyPublic() {
  ensureDir(OUT_DIR);
  for (const name of fs.readdirSync(PUBLIC_DIR)) {
    const src = path.join(PUBLIC_DIR, name);
    const dest = path.join(OUT_DIR, name);
    if (fs.statSync(src).isDirectory()) continue;
    let text = fs.readFileSync(src, "utf8");
    if (name === "index.html") {
      text = text
        .replace(/href="\/styles\.css[^"]*"/, 'href="./styles.css"')
        .replace(/src="\/app\.js[^"]*"/, 'src="./app.js"')
        .replace(/href="\/"/g, 'href="./"')
        .replace("<html lang=\"en\">", '<html lang="en" data-static="true">');
      if (!text.includes('id="site-base"')) {
        text = text.replace(
          "<head>",
          '<head>\n    <script>window.__MLB_STATIC__=true;</script>',
        );
      }
    }
    fs.writeFileSync(dest, text);
  }
}

function loadLatestOdds() {
  for (const p of DATA_PATHS) {
    if (!fs.existsSync(p)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      if (Array.isArray(data.odds) && data.odds.length) return data;
    } catch (error) {
      console.warn(`Could not read ${p}: ${error.message}`);
    }
  }
  return null;
}

function booksFromValueOdds(valueOdds, awayTeam, homeTeam) {
  const books = {};
  const eventOdds = (valueOdds || []).filter((odd) => {
    const ev = String(odd.event || "").toLowerCase();
    return (
      ev.includes(String(awayTeam || "").toLowerCase().split(" ").pop()) &&
      ev.includes(String(homeTeam || "").toLowerCase().split(" ").pop())
    );
  });

  const ml = eventOdds.filter((o) => o.category === "Moneyline" || o.market === "Moneyline");
  const awayMl = ml.find((o) => String(o.name).includes(awayTeam.split(" ").pop()));
  const homeMl = ml.find((o) => String(o.name).includes(homeTeam.split(" ").pop()));
  if (awayMl?.price) books.mlAway = awayMl.price;
  if (homeMl?.price) books.mlHome = homeMl.price;

  const spreads = eventOdds.filter((o) => o.category === "Spread" || o.market === "Spread");
  const homeSpread = spreads.find((o) => String(o.name).includes(homeTeam.split(" ").pop()));
  if (homeSpread && Number.isFinite(homeSpread.line)) {
    books.spreadLine = homeSpread.line;
    books.spreadHome = homeSpread.price;
    const awaySpread = spreads.find(
      (o) =>
        String(o.name).includes(awayTeam.split(" ").pop()) &&
        Number.isFinite(o.line) &&
        o.line === -homeSpread.line,
    );
    if (awaySpread?.price) books.spreadAway = awaySpread.price;
  }

  const totals = eventOdds.filter(
    (o) => (o.category === "Total" || o.market === "Total") && o.side,
  );
  const over = totals.find((o) => o.side === "Over");
  const under = totals.find((o) => o.side === "Under");
  if (over && Number.isFinite(over.line)) {
    books.totalLine = over.line;
    books.totalOver = over.price;
  }
  if (under?.price) books.totalUnder = under.price;

  return books;
}

async function main() {
  console.log("Building static GitHub Pages site…");
  if (fs.existsSync(OUT_DIR)) fs.rmSync(OUT_DIR, { recursive: true, force: true });
  copyPublic();

  const apiDir = path.join(OUT_DIR, "api");
  ensureDir(apiDir);
  ensureDir(path.join(apiDir, "live"));

  const latest = loadLatestOdds();
  const rows = latest?.odds || [];
  const { odds, arbs } = findValueFromOddsRows(rows);
  const eventNames = [
    ...new Set(odds.map((o) => o.event).filter(Boolean)),
  ];

  const books = new Map();
  for (const odd of odds) {
    const id = odd.sportsbook?.id;
    if (!id) continue;
    books.set(id, (books.get(id) || 0) + 1);
  }
  const feeds = [...books.entries()].map(([id, count]) => ({
    sportsbook: {
      id,
      name: id.charAt(0).toUpperCase() + id.slice(1),
    },
    updated: latest?.capturedAt || null,
    count,
    unavailable: false,
  }));

  writeJson(path.join(apiDir, "odds.json"), {
    fetchedAt: new Date().toISOString(),
    feedUpdated: latest?.capturedAt || null,
    cached: true,
    connected: false,
    mode: "static-pages",
    activeMarket: null,
    methodology:
      "Static GitHub Pages snapshot from scraper odds + ESPN/MLB Stats. Polls refresh when Actions rebuilds the site.",
    league: { id: "mlb", name: "MLB", sport: "Baseball" },
    books: feeds.map((f) => f.sportsbook),
    selectedBooks: [...books.keys()],
    rawQuoteCount: rows.length,
    odds,
    arbs,
    feeds,
    source: latest ? "data/latest.json" : "empty",
  });

  let liveBoard = { games: [], updatedAt: new Date().toISOString() };
  try {
    liveBoard = await buildLiveBoard(eventNames);
  } catch (error) {
    console.warn(`Live board failed: ${error.message}`);
    if (Array.isArray(latest?.games)) {
      liveBoard = {
        games: latest.games,
        updatedAt: latest.capturedAt || new Date().toISOString(),
        error: error.message,
      };
    }
  }
  writeJson(path.join(apiDir, "live.json"), liveBoard);

  const games = liveBoard.games || [];
  for (const game of games.slice(0, 40)) {
    try {
      const detail = await buildGameDetail(game.id, eventNames);
      writeJson(path.join(apiDir, "live", `${game.id}.json`), detail);
    } catch (error) {
      writeJson(path.join(apiDir, "live", `${game.id}.json`), {
        error: error.message || "Game detail unavailable",
        game,
      });
    }
  }

  try {
    const cache = await buildPrematchPredictions();
    const gamesOut = (cache.predictions || []).map((pred) =>
      enrichWithBooks(pred, booksFromValueOdds(odds, pred.awayTeam, pred.homeTeam)),
    );
    writeJson(path.join(apiDir, "predictions.json"), {
      date: cache.date,
      exponent: cache.exponent,
      lgAvgRuns: cache.lgAvgRuns,
      methodology:
        "Projected runs (Pythagorean OS/DS + pitcher/L20/HFA) → Skellam ML & spread + Poisson total fair prices. Static Pages rebuild.",
      games: gamesOut,
    });
  } catch (error) {
    console.warn(`Predictions failed: ${error.message}`);
    writeJson(path.join(apiDir, "predictions.json"), {
      games: [],
      error: error.message || "Predictions unavailable",
    });
  }

  writeJson(path.join(apiDir, "meta.json"), {
    builtAt: new Date().toISOString(),
    oddsCount: odds.length,
    arbCount: arbs.length,
    liveGames: games.length,
    hasScraperData: Boolean(latest),
  });

  console.log(
    `Done → ${OUT_DIR} (${odds.length} odds, ${games.length} live games, ${arbs.length} arbs)`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
