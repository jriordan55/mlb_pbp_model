// MLB Stats API client for Pythagorean prematch predictions
// https://statsapi.mlb.com — same sources as WalrusQuant/mlb-pe

const {
  RECENT_FORM_WINDOW,
  optimizeExponent,
  estimateGame,
  attachMarketEv,
} = require("./model");

const SCHEDULE_BASE = "https://statsapi.mlb.com/api/v1/schedule";
const PEOPLE_BASE = "https://statsapi.mlb.com/api/v1/people";
const USER_AGENT = "mlb_pbp_model/pythag (github.com/jriordan55/mlb_pbp_model)";

const CACHE_TTL_MS = 10 * 60 * 1000;
const PITCHER_TTL_MS = 60 * 60 * 1000;

let scheduleCache = { at: 0, season: null, games: null };
let pitcherCache = { at: 0, map: new Map() };
let predictionCache = {
  at: 0,
  requestedDate: null,
  date: null,
  byGamePk: new Map(),
  byMatchup: new Map(),
};

function currentSeason() {
  const now = new Date();
  // MLB season year switches after calendar year ends; use year of today's date.
  return now.getFullYear();
}

function todayEt() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function parseInnings(s) {
  if (s == null || String(s).trim() === "") return null;
  const str = String(s).trim();
  const [wholeS, fracS = "0"] = str.includes(".") ? str.split(".") : [str, "0"];
  const whole = Number(wholeS);
  if (!Number.isFinite(whole)) return null;
  let thirds;
  if (fracS === "0" || fracS === "") thirds = 0;
  else if (fracS === "1") thirds = 1 / 3;
  else if (fracS === "2") thirds = 2 / 3;
  else return null;
  return whole + thirds;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`MLB API ${res.status}: ${url}`);
  return res.json();
}

async function fetchSeasonSchedule(season = currentSeason()) {
  const now = Date.now();
  if (
    scheduleCache.games &&
    scheduleCache.season === season &&
    now - scheduleCache.at < CACHE_TTL_MS
  ) {
    return scheduleCache.games;
  }
  const url = `${SCHEDULE_BASE}?sportId=1&season=${season}&gameType=R&hydrate=probablePitcher`;
  const data = await fetchJson(url);
  const games = [];
  for (const day of data.dates || []) {
    for (const g of day.games || []) {
      const detailed = g.status?.detailedState || "";
      if (detailed === "Postponed" || detailed === "Cancelled") continue;
      if (g.seriesDescription && g.seriesDescription !== "Regular Season") continue;
      const abstract = g.status?.abstractGameState || "";
      let status = "Other";
      if (abstract === "Final") status = "Final";
      else if (abstract === "Live") status = "Live";
      else if (abstract === "Preview") status = "Preview";
      const date = g.officialDate || day.date;
      games.push({
        gamePk: g.gamePk,
        date,
        status,
        homeTeamId: g.teams?.home?.team?.id,
        homeTeamName: g.teams?.home?.team?.name || "",
        homeRuns: g.teams?.home?.score ?? null,
        awayTeamId: g.teams?.away?.team?.id,
        awayTeamName: g.teams?.away?.team?.name || "",
        awayRuns: g.teams?.away?.score ?? null,
        homePitcherId: g.teams?.home?.probablePitcher?.id ?? null,
        homePitcherName: g.teams?.home?.probablePitcher?.fullName ?? null,
        awayPitcherId: g.teams?.away?.probablePitcher?.id ?? null,
        awayPitcherName: g.teams?.away?.probablePitcher?.fullName ?? null,
      });
    }
  }
  scheduleCache = { at: now, season, games };
  return games;
}

async function fetchPitcherStats(season, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const now = Date.now();
  if (now - pitcherCache.at > PITCHER_TTL_MS) {
    pitcherCache = { at: now, map: new Map() };
  }
  const missing = unique.filter((id) => !pitcherCache.map.has(id));
  if (missing.length) {
    // Batch in chunks of 50
    for (let i = 0; i < missing.length; i += 50) {
      const chunk = missing.slice(i, i + 50);
      const url = `${PEOPLE_BASE}?personIds=${chunk.join(",")}&hydrate=stats(group=[pitching],type=[season],season=${season})`;
      try {
        const data = await fetchJson(url);
        for (const p of data.people || []) {
          let era = null;
          let ip = null;
          for (const sg of p.stats || []) {
            if (sg.group?.displayName !== "pitching") continue;
            for (const split of sg.splits || []) {
              const st = split.stat || {};
              const e = st.era != null ? Number(st.era) : null;
              const inn = parseInnings(st.inningsPitched);
              if (Number.isFinite(e) && inn != null) {
                era = e;
                ip = inn;
              }
            }
          }
          if (era != null && ip != null) {
            pitcherCache.map.set(p.id, {
              id: p.id,
              name: p.fullName,
              era,
              inningsPitched: ip,
            });
          }
        }
      } catch {
        // leave missing
      }
    }
  }
  const out = new Map();
  for (const id of unique) {
    if (pitcherCache.map.has(id)) out.set(id, pitcherCache.map.get(id));
  }
  return out;
}

function computeTeamStats(games, exponent) {
  const agg = new Map();
  let totalRuns = 0;
  let totalFinished = 0;

  for (const g of games) {
    if (g.status !== "Final" || g.homeRuns == null || g.awayRuns == null) continue;
    totalRuns += g.homeRuns + g.awayRuns;
    totalFinished += 1;
    for (const side of ["home", "away"]) {
      const id = side === "home" ? g.homeTeamId : g.awayTeamId;
      const name = side === "home" ? g.homeTeamName : g.awayTeamName;
      const rs = side === "home" ? g.homeRuns : g.awayRuns;
      const ra = side === "home" ? g.awayRuns : g.homeRuns;
      if (!agg.has(id)) {
        agg.set(id, {
          teamId: id,
          team: name,
          runsScored: 0,
          runsAllowed: 0,
          gamesPlayed: 0,
          wins: 0,
          losses: 0,
        });
      }
      const row = agg.get(id);
      row.runsScored += rs;
      row.runsAllowed += ra;
      row.gamesPlayed += 1;
      if (rs > ra) row.wins += 1;
      else if (ra > rs) row.losses += 1;
    }
  }

  const lgAvgRuns = totalFinished > 0 ? totalRuns / (2 * totalFinished) : 4.5;
  const recent = computeRecentForm(games, RECENT_FORM_WINDOW);

  const teams = [];
  for (const [teamId, row] of agg) {
    const r = recent.get(teamId);
    teams.push({
      ...row,
      recentGames: r?.games ?? null,
      recentRsPerGame: r?.rsPerGame ?? null,
      recentRaPerGame: r?.raPerGame ?? null,
    });
  }

  const fitted =
    exponent != null ? exponent : optimizeExponent(teams);
  return { teams, lgAvgRuns, exponent: fitted };
}

function computeRecentForm(games, window) {
  const byTeam = new Map();
  const sorted = [...games]
    .filter((g) => g.status === "Final" && g.homeRuns != null && g.awayRuns != null)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.gamePk - b.gamePk);

  for (const g of sorted) {
    for (const side of ["home", "away"]) {
      const id = side === "home" ? g.homeTeamId : g.awayTeamId;
      const rs = side === "home" ? g.homeRuns : g.awayRuns;
      const ra = side === "home" ? g.awayRuns : g.homeRuns;
      if (!byTeam.has(id)) byTeam.set(id, []);
      byTeam.get(id).push({ date: g.date, rs, ra });
    }
  }

  const out = new Map();
  for (const [id, rows] of byTeam) {
    const slice = rows.slice(-window);
    const n = slice.length;
    if (!n) continue;
    const rs = slice.reduce((s, x) => s + x.rs, 0);
    const ra = slice.reduce((s, x) => s + x.ra, 0);
    out.set(id, {
      games: n,
      rsPerGame: rs / n,
      raPerGame: ra / n,
    });
  }
  return out;
}

function normalizeTeamKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Map common short names / BoltOdds names to MLB full names. */
const TEAM_ALIASES = {
  arizona: "Arizona Diamondbacks",
  diamondbacks: "Arizona Diamondbacks",
  dbacks: "Arizona Diamondbacks",
  atl: "Atlanta Braves",
  braves: "Atlanta Braves",
  baltimore: "Baltimore Orioles",
  orioles: "Baltimore Orioles",
  boston: "Boston Red Sox",
  redsox: "Boston Red Sox",
  cubs: "Chicago Cubs",
  chicagocubs: "Chicago Cubs",
  whitesox: "Chicago White Sox",
  chicagowhitesox: "Chicago White Sox",
  cws: "Chicago White Sox",
  cincinnati: "Cincinnati Reds",
  reds: "Cincinnati Reds",
  cleveland: "Cleveland Guardians",
  guardians: "Cleveland Guardians",
  colorado: "Colorado Rockies",
  rockies: "Colorado Rockies",
  detroit: "Detroit Tigers",
  tigers: "Detroit Tigers",
  houston: "Houston Astros",
  astros: "Houston Astros",
  kansascity: "Kansas City Royals",
  royals: "Kansas City Royals",
  angels: "Los Angeles Angels",
  laa: "Los Angeles Angels",
  losangelesangels: "Los Angeles Angels",
  dodgers: "Los Angeles Dodgers",
  lad: "Los Angeles Dodgers",
  losangelesdodgers: "Los Angeles Dodgers",
  miami: "Miami Marlins",
  marlins: "Miami Marlins",
  milwaukee: "Milwaukee Brewers",
  brewers: "Milwaukee Brewers",
  minnesota: "Minnesota Twins",
  twins: "Minnesota Twins",
  mets: "New York Mets",
  nym: "New York Mets",
  newyorkmets: "New York Mets",
  yankees: "New York Yankees",
  nyy: "New York Yankees",
  newyorkyankees: "New York Yankees",
  athletics: "Athletics",
  oakland: "Athletics",
  oaklandathletics: "Athletics",
  philadelphia: "Philadelphia Phillies",
  phillies: "Philadelphia Phillies",
  pittsburgh: "Pittsburgh Pirates",
  pirates: "Pittsburgh Pirates",
  sandiego: "San Diego Padres",
  padres: "San Diego Padres",
  sanfrancisco: "San Francisco Giants",
  giants: "San Francisco Giants",
  seattle: "Seattle Mariners",
  mariners: "Seattle Mariners",
  stlouis: "St. Louis Cardinals",
  cardinals: "St. Louis Cardinals",
  tampabay: "Tampa Bay Rays",
  rays: "Tampa Bay Rays",
  texas: "Texas Rangers",
  rangers: "Texas Rangers",
  toronto: "Toronto Blue Jays",
  bluejays: "Toronto Blue Jays",
  washington: "Washington Nationals",
  nationals: "Washington Nationals",
};

function resolveTeamName(raw, teamByName) {
  const key = normalizeTeamKey(raw);
  if (teamByName.has(key)) return teamByName.get(key);
  if (TEAM_ALIASES[key]) {
    const full = TEAM_ALIASES[key];
    const fullKey = normalizeTeamKey(full);
    if (teamByName.has(fullKey)) return teamByName.get(fullKey);
  }
  // fuzzy: contains
  for (const [k, t] of teamByName) {
    if (k.includes(key) || key.includes(k)) return t;
  }
  return null;
}

async function buildPrematchPredictions(date = todayEt()) {
  const now = Date.now();
  if (
    predictionCache.byGamePk.size &&
    predictionCache.requestedDate === date &&
    now - predictionCache.at < CACHE_TTL_MS
  ) {
    return {
      date: predictionCache.date,
      exponent: predictionCache.exponent,
      lgAvgRuns: predictionCache.lgAvgRuns,
      predictions: [...predictionCache.byGamePk.values()],
      byGamePk: predictionCache.byGamePk,
      byMatchup: predictionCache.byMatchup,
    };
  }

  const season = currentSeason();
  const games = await fetchSeasonSchedule(season);
  const { teams, lgAvgRuns, exponent } = computeTeamStats(games);
  const teamById = new Map(teams.map((t) => [t.teamId, t]));
  const teamByName = new Map();
  for (const t of teams) {
    teamByName.set(normalizeTeamKey(t.team), t);
  }

  let slateDate = date;
  let slate = games.filter((g) => g.date === slateDate && g.status === "Preview");
  // After the day's games finish, roll forward to the next Preview slate.
  if (!slate.length) {
    const upcoming = games
      .filter((g) => g.status === "Preview" && String(g.date) >= String(date))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.gamePk - b.gamePk);
    if (upcoming.length) {
      slateDate = upcoming[0].date;
      slate = upcoming.filter((g) => g.date === slateDate);
    }
  }

  const pitcherIds = [];
  for (const g of slate) {
    if (g.homePitcherId) pitcherIds.push(g.homePitcherId);
    if (g.awayPitcherId) pitcherIds.push(g.awayPitcherId);
  }
  const pitchers = await fetchPitcherStats(season, pitcherIds);

  const byGamePk = new Map();
  const byMatchup = new Map();
  const predictions = [];

  for (const g of slate) {
    const home = teamById.get(g.homeTeamId);
    const away = teamById.get(g.awayTeamId);
    if (!home || !away) continue;
    const homeP = g.homePitcherId ? pitchers.get(g.homePitcherId) : null;
    const awayP = g.awayPitcherId ? pitchers.get(g.awayPitcherId) : null;
    const pred = estimateGame({
      home,
      away,
      lgAvgRuns,
      homePitcher: homeP,
      awayPitcher: awayP,
      exponent,
      applyHomeField: true,
      applyRecentForm: true,
      applyPitcherAdj: true,
    });
    const row = {
      gamePk: g.gamePk,
      date: g.date,
      awayTeam: g.awayTeamName,
      homeTeam: g.homeTeamName,
      awayPitcher: g.awayPitcherName,
      homePitcher: g.homePitcherName,
      awayPitcherEra: awayP?.era ?? null,
      homePitcherEra: homeP?.era ?? null,
      ...pred,
    };
    predictions.push(row);
    byGamePk.set(g.gamePk, row);
    byMatchup.set(
      `${normalizeTeamKey(g.awayTeamName)}@${normalizeTeamKey(g.homeTeamName)}`,
      row,
    );
  }

  predictionCache = {
    at: now,
    requestedDate: date,
    date: slateDate,
    exponent,
    lgAvgRuns,
    byGamePk,
    byMatchup,
  };

  return {
    date: slateDate,
    exponent,
    lgAvgRuns,
    predictions,
    byGamePk,
    byMatchup,
    teamByName,
  };
}

function findPredictionForMatchup(awayName, homeName, cache) {
  if (!cache?.byMatchup) return null;
  const key = `${normalizeTeamKey(awayName)}@${normalizeTeamKey(homeName)}`;
  if (cache.byMatchup.has(key)) return cache.byMatchup.get(key);
  // try resolve aliases then lookup
  for (const [mk, row] of cache.byMatchup) {
    const [a, h] = mk.split("@");
    const wantA = normalizeTeamKey(awayName);
    const wantH = normalizeTeamKey(homeName);
    if (
      (a.includes(wantA) || wantA.includes(a) || TEAM_ALIASES[wantA] && normalizeTeamKey(TEAM_ALIASES[wantA]) === a) &&
      (h.includes(wantH) || wantH.includes(h) || TEAM_ALIASES[wantH] && normalizeTeamKey(TEAM_ALIASES[wantH]) === h)
    ) {
      return row;
    }
  }
  return null;
}

/**
 * Enrich a BoltOdds fixture with Pythagorean fair prices + EV.
 * books: { homeMl, awayMl, homeMlBook, awayMlBook, homeSpread, awaySpread, ... }
 */
function enrichWithBooks(prediction, books) {
  if (!prediction) return null;
  return attachMarketEv(prediction, books || {});
}

module.exports = {
  currentSeason,
  todayEt,
  fetchSeasonSchedule,
  buildPrematchPredictions,
  findPredictionForMatchup,
  enrichWithBooks,
  normalizeTeamKey,
  resolveTeamName,
};
