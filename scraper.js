// Adaptive MLB scraper — BoltOdds (Starter rotation) + ESPN play-by-play/state.
//
// Modes:
//   prematch  → full odds + board/injuries every 10 minutes
//   inplay    → odds + pitch/play-by-play + game state on a short loop
//
// Outputs (under data/):
//   mlb_odds_history.csv
//   mlb_plays_history.csv          (each new play + best-line odds snapshot)
//   mlb_play_odds.csv              (every book quote linked to each new play)
//   mlb_game_state.csv
//   mlb_injuries_history.csv
//   snapshots/<timestamp>.json
//   latest.json
//
// Run forever:     npm run scrape
// One cycle:       npm run scrape -- --once
// Live session:    npm run scrape -- --live-session
//   (--live-session loops while any ESPN game is in-progress, then exits;
//    used by GitHub Actions so capture continues with your PC off)

const fs = require("node:fs");
const path = require("node:path");
const WebSocket = globalThis.WebSocket || require("ws");
const {
  getScoreboard,
  getGamePlays,
  buildGameDetail,
  buildLiveBoard,
  parseBoltTeams,
  teamsMatch,
} = require("./espn");

const ROOT = __dirname;
const DATA_DIR = process.env.SCRAPER_DATA_DIR
  ? path.resolve(process.env.SCRAPER_DATA_DIR)
  : path.join(ROOT, "data");
const SNAPSHOT_DIR = path.join(DATA_DIR, "snapshots");
const SEEN_PLAYS_PATH = path.join(DATA_DIR, ".seen_plays.json");

const PREMATCH_INTERVAL_MS = Number(process.env.PREMATCH_INTERVAL_MS) || 10 * 60 * 1000;
const INPLAY_INTERVAL_MS = Number(process.env.INPLAY_INTERVAL_MS) || 8_000;
const MARKET_DWELL_MS = Number(process.env.MARKET_DWELL_MS) || 5_000;
const LIVE_SESSION_MAX_MS = Number(process.env.LIVE_SESSION_MAX_MS) || 4 * 60 * 60 * 1000;
const SPORT = "MLB";
const MARKETS = ["Moneyline", "Spread", "Total"];
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

const ODDS_COLUMNS = [
  "captured_at",
  "mode",
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

const PLAY_COLUMNS = [
  "captured_at",
  "event_id",
  "game",
  "play_id",
  "period",
  "clock",
  "scoring_play",
  "away_score",
  "home_score",
  "type",
  "text",
  "matched_odds_game",
  "away_team",
  "home_team",
  "away_ml_best",
  "away_ml_book",
  "home_ml_best",
  "home_ml_book",
  "spread_line",
  "away_spread_odds",
  "away_spread_book",
  "home_spread_odds",
  "home_spread_book",
  "total_line",
  "over_odds",
  "over_book",
  "under_odds",
  "under_book",
  "odds_quote_count",
];

const PLAY_ODDS_COLUMNS = [
  "captured_at",
  "event_id",
  "play_id",
  "game",
  "matched_odds_game",
  "market",
  "sportsbook",
  "selection",
  "target",
  "side",
  "line",
  "odds",
  "link",
];

const STATE_COLUMNS = [
  "captured_at",
  "event_id",
  "game",
  "state",
  "status_detail",
  "away_team",
  "home_team",
  "away_score",
  "home_score",
  "home_win_pct",
  "venue",
  "matched_odds_game",
  "away_ml_best",
  "away_ml_book",
  "home_ml_best",
  "home_ml_book",
  "spread_line",
  "away_spread_odds",
  "away_spread_book",
  "home_spread_odds",
  "home_spread_book",
  "total_line",
  "over_odds",
  "over_book",
  "under_odds",
  "under_book",
  "odds_quote_count",
];

const INJURY_COLUMNS = [
  "captured_at",
  "event_id",
  "game",
  "team",
  "player",
  "position",
  "status",
  "injury",
  "return_date",
  "note",
];

loadEnv(path.join(ROOT, ".env"));
const BOLT_KEY = process.env.BOLTODDS_API_KEY;
if (!BOLT_KEY) {
  console.error("BOLTODDS_API_KEY is missing. Add it to .env or the cloud secret store.");
  process.exit(1);
}

fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

const args = new Set(process.argv.slice(2));
const RUN_ONCE = args.has("--once");
const LIVE_SESSION = args.has("--live-session");

const seenPlays = loadSeenPlays();

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

function loadSeenPlays() {
  try {
    if (!fs.existsSync(SEEN_PLAYS_PATH)) return new Set();
    const parsed = JSON.parse(fs.readFileSync(SEEN_PLAYS_PATH, "utf8"));
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function saveSeenPlays() {
  // Keep the file bounded — last ~20k play ids is plenty for a season week.
  const values = [...seenPlays];
  const trimmed = values.length > 20_000 ? values.slice(values.length - 20_000) : values;
  fs.writeFileSync(SEEN_PLAYS_PATH, JSON.stringify(trimmed));
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function appendCsv(filePath, columns, rows) {
  if (!rows.length) return;
  if (fs.existsSync(filePath)) {
    const existingHeader = fs.readFileSync(filePath, "utf8").split(/\r?\n/, 1)[0] || "";
    const expected = columns.join(",");
    if (existingHeader && existingHeader !== expected) {
      const legacy = filePath.replace(/\.csv$/i, `.legacy-${Date.now()}.csv`);
      fs.renameSync(filePath, legacy);
      console.log(`  rotated schema mismatch -> ${path.basename(legacy)}`);
    }
  }
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `${columns.join(",")}\r\n`);
  }
  const lines = rows.map((row) => columns.map((column) => csvEscape(row[column])).join(","));
  fs.appendFileSync(filePath, `${lines.join("\r\n")}\r\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function americanToDecimal(price) {
  const value = Number(String(price).replace(/[+−]/g, (match) => (match === "−" ? "-" : "")));
  if (!Number.isFinite(value) || value === 0) return null;
  return value > 0 ? 1 + value / 100 : 1 + 100 / Math.abs(value);
}

function bestQuote(quotes) {
  let best = null;
  for (const quote of quotes) {
    const decimal = americanToDecimal(quote.odds);
    if (decimal == null) continue;
    if (!best || decimal > best.decimal) best = { ...quote, decimal };
  }
  return best;
}

function oddsRowsForGame(oddsRows, game, detail) {
  const matched = detail.game?.matchedEvent || game.matchedEvent || "";
  if (matched) {
    const exact = oddsRows.filter((row) => row.game === matched);
    if (exact.length) return { matchedGame: matched, rows: exact };
  }

  const away = detail.game?.away?.name || game.away?.name || "";
  const home = detail.game?.home?.name || game.home?.name || "";
  const rows = oddsRows.filter((row) => {
    const teams = parseBoltTeams(row.game);
    if (teams.length !== 2 || !away || !home) return false;
    return (
      (teamsMatch(away, teams[0]) && teamsMatch(home, teams[1])) ||
      (teamsMatch(away, teams[1]) && teamsMatch(home, teams[0]))
    );
  });
  return { matchedGame: rows[0]?.game || matched || "", rows };
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

function summarizeGameOdds(gameOdds, awayName, homeName) {
  const ml = gameOdds.filter((row) => row.market === "Moneyline");
  const spreads = gameOdds.filter((row) => row.market === "Spread");
  const totals = gameOdds.filter((row) => row.market === "Total");

  const awayMl = bestQuote(ml.filter((row) => teamsMatch(row.target, awayName)));
  const homeMl = bestQuote(ml.filter((row) => teamsMatch(row.target, homeName)));

  const preferredSpread = mostCommonLine(
    spreads.map((row) => Math.abs(Number(row.line))).filter(Number.isFinite),
  );
  const spreadPool = Number.isFinite(preferredSpread)
    ? spreads.filter((row) => Math.abs(Number(row.line)) === preferredSpread)
    : spreads;
  const awaySpread = bestQuote(
    spreadPool.filter((row) => teamsMatch(row.target, awayName)),
  );
  const homeSpread = bestQuote(
    spreadPool.filter((row) => teamsMatch(row.target, homeName)),
  );

  const preferredTotal = mostCommonLine(
    totals.map((row) => Number(row.line)).filter(Number.isFinite),
  );
  const totalPool = Number.isFinite(preferredTotal)
    ? totals.filter((row) => Number(row.line) === preferredTotal)
    : totals;
  const over = bestQuote(
    totalPool.filter((row) => /^(o|over)$/i.test(String(row.side || ""))),
  );
  const under = bestQuote(
    totalPool.filter((row) => /^(u|under)$/i.test(String(row.side || ""))),
  );

  return {
    away_ml_best: awayMl?.odds || "",
    away_ml_book: awayMl?.sportsbook || "",
    home_ml_best: homeMl?.odds || "",
    home_ml_book: homeMl?.sportsbook || "",
    spread_line: preferredSpread ?? "",
    away_spread_odds: awaySpread?.odds || "",
    away_spread_book: awaySpread?.sportsbook || "",
    home_spread_odds: homeSpread?.odds || "",
    home_spread_book: homeSpread?.sportsbook || "",
    total_line: preferredTotal ?? "",
    over_odds: over?.odds || "",
    over_book: over?.sportsbook || "",
    under_odds: under?.odds || "",
    under_book: under?.sportsbook || "",
    odds_quote_count: gameOdds.length,
  };
}

function deduplicateOdds(rows) {
  const byKey = new Map();
  for (const row of rows) {
    byKey.set(`${row.market}|${row.game}|${row.sportsbook}|${row.selection}`, row);
  }
  return [...byKey.values()];
}

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

async function captureOdds(mode, capturedAt) {
  const allRows = [];
  for (const market of MARKETS) {
    const rows = deduplicateOdds(await captureMarket(market));
    console.log(`  odds ${market}: ${rows.length}`);
    for (const row of rows) allRows.push({ captured_at: capturedAt, mode, ...row });
    await sleep(400);
  }
  appendCsv(path.join(DATA_DIR, "mlb_odds_history.csv"), ODDS_COLUMNS, allRows);
  return allRows;
}

async function captureEspn(mode, capturedAt, oddsRows) {
  const oddsEvents = [...new Set(oddsRows.map((row) => row.game).filter(Boolean))];
  const board = await buildLiveBoard(oddsEvents);
  const games = board.games || [];
  const liveGames = games.filter((game) => game.status?.state === "in");
  const preGames = games.filter((game) => game.status?.state === "pre");
  // Prematch: scheduled games only. In-play: live games (PBP + state).
  const targets = mode === "inplay" ? liveGames : preGames;

  const playRows = [];
  const playOddsRows = [];
  const stateRows = [];
  const injuryRows = [];
  const details = [];

  for (const game of targets) {
    const detail = await buildGameDetail(game.id, oddsEvents, { fresh: true });
    details.push(detail);

    const awayName = detail.game?.away?.name || game.away?.name || "";
    const homeName = detail.game?.home?.name || game.home?.name || "";
    const { matchedGame, rows: gameOdds } = oddsRowsForGame(oddsRows, game, detail);
    const oddsSummary = summarizeGameOdds(gameOdds, awayName, homeName);

    stateRows.push({
      captured_at: capturedAt,
      event_id: game.id,
      game: detail.game?.name || game.name || "",
      state: detail.game?.status?.state || game.status?.state || "",
      status_detail: detail.game?.status?.detail || game.status?.detail || "",
      away_team: awayName,
      home_team: homeName,
      away_score: detail.game?.away?.score ?? game.away?.score ?? "",
      home_score: detail.game?.home?.score ?? game.home?.score ?? "",
      home_win_pct:
        detail.winProbability?.homeWinPct != null
          ? detail.winProbability.homeWinPct
          : "",
      venue: detail.game?.venue || game.venue || "",
      matched_odds_game: matchedGame,
      ...oddsSummary,
    });

    // Pitch / play-by-play only while the game is live.
    if ((detail.game?.status?.state || game.status?.state) === "in") {
      const plays = [...(detail.plays || [])].reverse();
      for (const play of plays) {
        const playId = String(
          play.id || `${game.id}:${play.text}:${play.period}:${play.clock}`,
        );
        const seenKey = `${game.id}|${playId}`;
        if (seenPlays.has(seenKey)) continue;
        seenPlays.add(seenKey);

        playRows.push({
          captured_at: capturedAt,
          event_id: game.id,
          game: detail.game?.name || game.name || "",
          play_id: playId,
          period: play.period ?? "",
          clock: play.clock ?? "",
          scoring_play: play.scoringPlay ? 1 : 0,
          away_score: play.awayScore ?? "",
          home_score: play.homeScore ?? "",
          type: play.type || "",
          text: play.text || "",
          matched_odds_game: matchedGame,
          away_team: awayName,
          home_team: homeName,
          ...oddsSummary,
        });

        // Full book-level odds snapshot at the moment this play first appeared.
        for (const quote of gameOdds) {
          playOddsRows.push({
            captured_at: capturedAt,
            event_id: game.id,
            play_id: playId,
            game: detail.game?.name || game.name || "",
            matched_odds_game: matchedGame || quote.game || "",
            market: quote.market || "",
            sportsbook: quote.sportsbook || "",
            selection: quote.selection || "",
            target: quote.target || "",
            side: quote.side || "",
            line: quote.line ?? "",
            odds: quote.odds ?? "",
            link: quote.link || "",
          });
        }
      }
    }

    if (mode === "prematch") {
      for (const inj of detail.injuries || []) {
        injuryRows.push({
          captured_at: capturedAt,
          event_id: game.id,
          game: detail.game?.name || game.name || "",
          team: inj.team || "",
          player: inj.player || "",
          position: inj.position || "",
          status: inj.status || "",
          injury: inj.injury || "",
          return_date: inj.returnDate || "",
          note: inj.note || "",
        });
      }
    }
  }

  appendCsv(path.join(DATA_DIR, "mlb_plays_history.csv"), PLAY_COLUMNS, playRows);
  appendCsv(path.join(DATA_DIR, "mlb_play_odds.csv"), PLAY_ODDS_COLUMNS, playOddsRows);
  appendCsv(path.join(DATA_DIR, "mlb_game_state.csv"), STATE_COLUMNS, stateRows);
  appendCsv(path.join(DATA_DIR, "mlb_injuries_history.csv"), INJURY_COLUMNS, injuryRows);
  saveSeenPlays();

  return {
    board,
    details,
    newPlays: playRows.length,
    playOdds: playOddsRows.length,
    states: stateRows.length,
    injuries: injuryRows.length,
    liveCount: liveGames.length,
  };
}

async function runCycle() {
  const capturedAt = new Date().toISOString();
  let boardPreview = [];
  try {
    boardPreview = await getScoreboard({ fresh: true });
  } catch (error) {
    console.error("  scoreboard error:", error.message);
  }
  const liveCount = boardPreview.filter((game) => game.status?.state === "in").length;
  const mode = liveCount > 0 ? "inplay" : "prematch";
  console.log(`\n[${capturedAt}] mode=${mode} liveGames=${liveCount}`);

  const oddsRows = await captureOdds(mode, capturedAt);
  let espn = {
    board: { games: boardPreview },
    details: [],
    newPlays: 0,
    states: 0,
    injuries: 0,
    liveCount,
  };
  try {
    espn = await captureEspn(mode, capturedAt, oddsRows);
  } catch (error) {
    console.error("  ESPN capture error:", error.message);
  }

  const snapshot = {
    capturedAt,
    mode,
    sport: SPORT,
    markets: MARKETS,
    sportsbooks: ALLOWED_SPORTSBOOKS,
    oddsCount: oddsRows.length,
    newPlays: espn.newPlays,
    gameStates: espn.states,
    injuries: espn.injuries,
    liveGames: espn.liveCount,
    games: (espn.board?.games || []).map((game) => ({
      id: game.id,
      name: game.name,
      status: game.status,
      away: game.away,
      home: game.home,
      matchedEvent: game.matchedEvent,
    })),
    odds: oddsRows,
    // Keep latest.json lean during in-play; full details only on prematch snapshots.
    details: mode === "prematch" ? espn.details : undefined,
  };

  fs.writeFileSync(path.join(DATA_DIR, "latest.json"), JSON.stringify(snapshot, null, 2));
  if (mode === "prematch" || RUN_ONCE) {
    const snapshotName = `${capturedAt.replace(/[:.]/g, "-")}.json`;
    fs.writeFileSync(
      path.join(SNAPSHOT_DIR, snapshotName),
      JSON.stringify({ ...snapshot, details: espn.details }, null, 2),
    );
  }

  console.log(
    `  saved odds=${oddsRows.length} newPlays=${espn.newPlays} playOdds=${espn.playOdds || 0} states=${espn.states} injuries=${espn.injuries} -> data/`,
  );
  return { mode, liveCount: espn.liveCount, snapshot };
}

async function runForever() {
  console.log(
    `MLB scraper starting (prematch every ${PREMATCH_INTERVAL_MS / 60000}m, in-play every ${INPLAY_INTERVAL_MS / 1000}s). Ctrl+C to stop.`,
  );
  for (;;) {
    let result;
    try {
      result = await runCycle();
    } catch (error) {
      console.error("Cycle failed:", error);
      await sleep(15_000);
      continue;
    }
    if (RUN_ONCE) break;
    const delay = result.mode === "inplay" ? INPLAY_INTERVAL_MS : PREMATCH_INTERVAL_MS;
    console.log(`  sleeping ${Math.round(delay / 1000)}s`);
    await sleep(delay);
  }
}

async function runLiveSession() {
  const started = Date.now();
  console.log(
    `MLB live-session scraper (max ${LIVE_SESSION_MAX_MS / 3600000}h). Exits when no live games remain.`,
  );
  // Always take at least one cycle (covers prematch on the Actions schedule).
  let result = await runCycle();
  while (result.liveCount > 0 && Date.now() - started < LIVE_SESSION_MAX_MS) {
    await sleep(INPLAY_INTERVAL_MS);
    result = await runCycle();
  }
  console.log(
    result.liveCount > 0
      ? "Live-session hit max duration; exiting."
      : "No live games left; session complete.",
  );
}

(async () => {
  if (LIVE_SESSION) await runLiveSession();
  else await runForever();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
