# mlb_pbp_model

MLB odds + play-by-play data pipeline and dashboard powered by the
[BoltOdds](https://boltodds.com/docs) real-time WebSocket feed and ESPN live data.

## Run locally

Node.js 18 or newer is required. No package installation is needed.

```powershell
cd C:\Users\student\Documents\mlb_pbp_model
npm start
```

Open [http://localhost:3000](http://localhost:3000).

The server opens one BoltOdds WebSocket connection at a time, subscribes to one
MLB market, stores the snapshot, closes the socket, and reconnects to the next
market. This keeps the app within one league / one market / one connection at a
time, while still showing the latest saved snapshot for multiple markets.

Because each market is only fresh when its turn comes up, this is not true
simultaneous all-market streaming. The dashboard shows a per-market freshness
line so stale categories are obvious.

## Odds Capture Script

To record odds history instead of (or alongside) the live dashboard:

```powershell
cd C:\Users\student\Documents\mlb_pbp_model
npm run capture
```

Every 10 minutes the script rotates through Moneyline, Spread, and Total (one
connection, one market at a time — Basic/Starter compatible) and stores every
quote it sees:

- `data/mlb_odds_history.csv` — one flat row per quote, appended on every run
- `data/snapshots/<timestamp>.json` — a complete JSON snapshot per run

Note: the Basic plan allows only one concurrent connection, so avoid running
`npm start` and `npm run capture` / `npm run scrape` at the same time on that plan.

## Adaptive Scraper (odds + play-by-play)

`scraper.js` pulls BoltOdds **and** ESPN game state together:

| Mode | When | Interval | What it stores |
|------|------|----------|----------------|
| Prematch | No live games | Every 10 minutes | Odds, injuries, board, JSON snapshot |
| In-play | Any ESPN game `in` | ~every 8 seconds | Odds + new plays + score/win-prob state |

```powershell
cd C:\Users\student\Documents\mlb_pbp_model
npm run scrape          # run forever (local)
npm run scrape:once     # one cycle
npm run scrape:live     # one cycle, then keep going while games are live
```

Files written under `data/`:

- `mlb_odds_history.csv`
- `mlb_plays_history.csv` (append-only new plays)
- `mlb_game_state.csv`
- `mlb_injuries_history.csv`
- `latest.json`
- `snapshots/<timestamp>.json` (prematch / `--once`)

### Keep scraping when your PC is off

**Option A — GitHub Actions (included)**  
Workflow: `.github/workflows/mlb-scraper.yml`

1. Push this repo to GitHub
2. Repo **Settings → Secrets → Actions** → add `BOLTODDS_API_KEY`
3. Enable Actions; it runs every 5 minutes. If games are live it stays on
   play-by-play polling (up to 4 hours), then commits CSV/`latest.json` back

**Option B — Render always-on worker**  
`render.yaml` blueprint: Docker worker + persistent `/data` disk. Set
`BOLTODDS_API_KEY` in the Render dashboard.

## Live ESPN Context

The dashboard also pulls live MLB context from the same public ESPN endpoints
used by [sports-leader-mcp](https://github.com/WalrusQuant/sports-leader-mcp):

- Scoreboard and game status
- Play-by-play
- Team stats / leaders
- Injury reports

Select a game chip to open that context and filter the odds/arb tables to the
matched BoltOdds event. No ESPN API key is required.

## Configuration

API keys are read from `.env` and only used by the local server — they are
never sent to the browser. `.env` is ignored by Git.

To configure a fresh checkout:

```powershell
Copy-Item .env.example .env
```

Then set `BOLTODDS_API_KEY` in `.env`.

## Included Markets And EV

The scanner rotates through:

- Moneyline
- Spread
- Total

For totals, each sportsbook's over/under prices at the same line are converted
to implied probabilities and normalized to remove vig. For moneylines and
spreads (paired at the same absolute line), both team prices are no-vigged the
same way. The displayed fair probability is the median across books. EV compares
that fair probability with the best available sportsbook price:

`EV = fair probability × decimal odds − 1`

These are market-consensus estimates, not guarantees of true probability.
