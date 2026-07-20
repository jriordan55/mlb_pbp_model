// Captures MLB odds snapshots every 10 minutes and stores them as CSV + JSON.
//
// Starter-plan friendly: opens ONE WebSocket connection at a time, subscribed
// to ONE market, closes it, then moves to the next market. A full cycle takes
// about 20–30 seconds, then the script sleeps until the next capture.
//
// Outputs:
//   data/odds_history.csv          - one flat row per quote, appended forever
//   data/snapshots/<time>.json     - full JSON snapshot per capture run
//
// Run with: npm run capture   (or: node capture_odds.js)

const fs = require("node:fs");
const path = require("node:path");
const WebSocket = globalThis.WebSocket || require("ws");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const SNAPSHOT_DIR = path.join(DATA_DIR, "snapshots");
const CSV_PATH = path.join(DATA_DIR, "mlb_odds_history.csv");

const CAPTURE_INTERVAL_MS = 10 * 60 * 1000;
const MARKET_DWELL_MS = 6_000;
const SPORT = "MLB";
const MARKETS = ["Moneyline", "Spread", "Total"];
const ALLOWED_SPORTSBOOKS = [
  "fanduel",
  "draftkings",
  "betmgm",
  "betonline",
  "thescore",
  "consensus",
];

const CSV_COLUMNS = [
  "captured_at",
  "sport",
  "market",
  "game",
  "starts_at",
  "sportsbook",
  "selection",
  "target",
  "side",
  "line",
  "odds",
  "link",
];

loadEnv(path.join(ROOT, ".env"));
const BOLT_KEY = process.env.BOLTODDS_API_KEY;
if (!BOLT_KEY) {
  console.error("BOLTODDS_API_KEY is missing. Add it to .env.");
  process.exit(1);
}

fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// Collect one market's full snapshot on a fresh connection, then disconnect.
function captureMarket(market) {
  return new Promise((resolve) => {
    const socket = new WebSocket(`wss://spro.agency/api?key=${BOLT_KEY}`);
    const rows = [];
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {}
      resolve(rows);
    };

    const timer = setTimeout(finish, MARKET_DWELL_MS + 8_000);

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
          setTimeout(finish, MARKET_DWELL_MS);
          continue;
        }
        if (item.action === "error") {
          console.error(`  [${market}] BoltOdds error: ${item.message}`);
          continue;
        }

        const data = item.data;
        if (!data || data.sport !== SPORT || !data.outcomes) continue;
        if (data.sportsbook && !ALLOWED_SPORTSBOOKS.includes(data.sportsbook)) continue;
        if (!["initial_state", "game_update", "game_added", "line_update"].includes(item.action)) {
          continue;
        }

        for (const [selection, outcome] of Object.entries(data.outcomes)) {
          if (!outcome || outcome.odds === null || outcome.odds === "") continue;
          rows.push({
            sport: SPORT,
            market,
            game: (data.game || "").replace(/,\s*[a-f0-9]{12}$/i, ""),
            starts_at: data.info?.when || "",
            sportsbook: data.sportsbook || "",
            selection,
            target: outcome.outcome_target || "",
            side: outcome.outcome_over_under || "",
            line: outcome.outcome_line ?? "",
            odds: outcome.odds,
            link: outcome.link || "",
          });
        }
      }
    });

    socket.addEventListener("close", () => {
      clearTimeout(timer);
      finish();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      finish();
    });
  });
}

// Keep the newest quote per (market, game, sportsbook, selection).
function deduplicate(rows) {
  const byKey = new Map();
  for (const row of rows) {
    byKey.set(`${row.market}|${row.game}|${row.sportsbook}|${row.selection}`, row);
  }
  return [...byKey.values()];
}

async function runCapture() {
  const capturedAt = new Date().toISOString();
  console.log(`\n[${capturedAt}] Starting capture cycle`);
  const allRows = [];

  for (const market of MARKETS) {
    const rows = deduplicate(await captureMarket(market));
    console.log(`  ${market}: ${rows.length} quotes`);
    for (const row of rows) allRows.push({ captured_at: capturedAt, ...row });
    // Small pause between reconnects to stay well under 12 connections/minute.
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!allRows.length) {
    console.log("  No quotes captured this cycle (no active MLB markets?)");
    return;
  }

  // CSV: append, writing the header only when creating the file.
  const lines = allRows.map((row) =>
    CSV_COLUMNS.map((column) => csvEscape(row[column])).join(","),
  );
  if (!fs.existsSync(CSV_PATH)) {
    fs.writeFileSync(CSV_PATH, `${CSV_COLUMNS.join(",")}\r\n`);
  }
  fs.appendFileSync(CSV_PATH, `${lines.join("\r\n")}\r\n`);

  // JSON: one complete snapshot file per capture run.
  const snapshotName = `${capturedAt.replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(
    path.join(SNAPSHOT_DIR, snapshotName),
    JSON.stringify({ capturedAt, sport: SPORT, markets: MARKETS, quotes: allRows }, null, 2),
  );

  console.log(
    `  Saved ${allRows.length} quotes -> data/mlb_odds_history.csv and data/snapshots/${snapshotName}`,
  );
}

(async () => {
  console.log(
    `MLB odds capture: ${MARKETS.length} markets, every ${CAPTURE_INTERVAL_MS / 60000} minutes. Ctrl+C to stop.`,
  );
  await runCapture();
  setInterval(runCapture, CAPTURE_INTERVAL_MS);
})();
