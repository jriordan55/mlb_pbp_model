// ESPN live data client — same public endpoints used by
// https://github.com/WalrusQuant/sports-leader-mcp (no auth required).

const SITE = "https://site.api.espn.com/apis/site/v2/sports";
const CORE = "https://sports.core.api.espn.com/v2/sports";
const SPORT = "baseball";
const LEAGUE = "mlb";

const cache = new Map();
const NON_INJURY = new Set(["Active", ""]);

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value, ttlMs) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

async function espnFetch(url, ttlMs = 60_000) {
  if (ttlMs > 0) {
    const cached = cacheGet(url);
    if (cached) return cached;
  }

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "mlb-pbp-model/1.0 (espn-live)",
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`ESPN ${response.status}: ${text.slice(0, 160)}`);
  }
  const data = await response.json();
  if (ttlMs > 0) cacheSet(url, data, ttlMs);
  return data;
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function teamTokens(name) {
  const normalized = normalizeName(name);
  const parts = normalized.split(/\s+/).filter(Boolean);
  // Prefer distinctive tokens (city + nickname when available).
  return new Set(parts);
}

function teamsMatch(a, b) {
  const left = teamTokens(a);
  const right = teamTokens(b);
  if (!left.size || !right.size) return false;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  // "new york mets" vs "new york mets" → full; "mets" vs "new york mets" → 1
  return overlap >= Math.min(2, Math.min(left.size, right.size));
}

function parseBoltTeams(eventName) {
  const base = String(eventName || "").split(",")[0].trim();
  const parts = base.split(/\s+vs\.?\s+/i);
  if (parts.length !== 2) return [];
  return parts.map((part) => part.trim()).filter(Boolean);
}

function compactCompetitor(competitor) {
  const team = competitor.team || {};
  return {
    id: team.id || null,
    homeAway: competitor.homeAway || null,
    abbreviation: team.abbreviation || "",
    name: team.displayName || team.name || "",
    shortName: team.shortDisplayName || team.name || "",
    logo: team.logo || team.logos?.[0]?.href || null,
    score: competitor.score ?? "0",
    record: competitor.records?.[0]?.displayValue || "",
    winner: Boolean(competitor.winner),
  };
}

function compactStatus(status) {
  const type = status?.type || {};
  return {
    state: type.state || "pre",
    completed: Boolean(type.completed),
    description: type.description || type.detail || "",
    detail: type.detail || type.shortDetail || "",
    shortDetail: type.shortDetail || type.detail || "",
  };
}

function compactPlay(play) {
  return {
    id: play.id || null,
    text: play.text || play.alternativeText || "",
    type: play.type?.text || play.type?.abbreviation || "",
    period: play.period?.displayValue || play.period?.number || null,
    clock: play.clock?.displayValue || null,
    scoringPlay: Boolean(play.scoringPlay),
    awayScore: play.awayScore ?? null,
    homeScore: play.homeScore ?? null,
  };
}

function compactInjury(inj, teamFallback) {
  const athlete = inj.athlete || {};
  const details = inj.details || {};
  const status = String(inj.status || "");
  if (NON_INJURY.has(status)) return null;
  return {
    player: athlete.displayName || "",
    position: athlete.position?.abbreviation || "",
    team: athlete.team?.abbreviation || teamFallback || "",
    status,
    injury: details.detail || details.type || "",
    returnDate: details.returnDate || null,
    note: inj.shortComment || inj.longComment || null,
  };
}

async function getScoreboard({ fresh = false } = {}) {
  const url = `${SITE}/${SPORT}/${LEAGUE}/scoreboard`;
  const data = await espnFetch(url, fresh ? 0 : 30_000);
  return (data.events || []).map((event) => {
    const competition = event.competitions?.[0] || {};
    const competitors = (competition.competitors || [])
      .map(compactCompetitor)
      .sort((a, b) => Number(a.homeAway === "home") - Number(b.homeAway === "home"));
    // competitors sorted away first for display convenience
    const away = competitors.find((c) => c.homeAway === "away") || competitors[0];
    const home = competitors.find((c) => c.homeAway === "home") || competitors[1];
    return {
      id: String(event.id),
      name: event.name || "",
      shortName: event.shortName || "",
      date: event.date || null,
      status: compactStatus(event.status || competition.status),
      venue: competition.venue?.fullName || null,
      away,
      home,
      competitors,
    };
  });
}

async function getLeagueInjuries() {
  const url = `${SITE}/${SPORT}/${LEAGUE}/injuries`;
  const data = await espnFetch(url, 300_000);
  const byTeam = new Map();
  for (const bucket of data.injuries || []) {
    const teamName = bucket.displayName || bucket.team?.displayName || "";
    const abbr = bucket.team?.abbreviation || "";
    const key = normalizeName(teamName || abbr);
    const injuries = (bucket.injuries || [])
      .map((inj) => compactInjury(inj, abbr || teamName))
      .filter(Boolean);
    if (!injuries.length) continue;
    byTeam.set(key, {
      team: teamName,
      abbreviation: abbr,
      injuries,
    });
  }
  return byTeam;
}

async function getGameSummary(eventId, { fresh = false } = {}) {
  const url = `${SITE}/${SPORT}/${LEAGUE}/summary?event=${encodeURIComponent(eventId)}`;
  return espnFetch(url, fresh ? 0 : 45_000);
}

async function getGamePlays(eventId, limit = 80, { fresh = false } = {}) {
  const url = `${CORE}/${SPORT}/leagues/${LEAGUE}/events/${eventId}/competitions/${eventId}/plays?limit=${limit}`;
  try {
    const data = await espnFetch(url, fresh ? 0 : 45_000);
    return (data.items || []).map(compactPlay).filter((play) => play.text);
  } catch {
    return [];
  }
}

function extractLeaders(summary) {
  // Summary leaders can be team-scoped categories or flat categories.
  const raw = summary.leaders || [];
  const out = [];
  for (const block of raw) {
    if (Array.isArray(block.leaders) && block.displayName && !block.team) {
      out.push({
        category: block.displayName || block.name || "",
        leaders: block.leaders.slice(0, 3).map((entry) => ({
          athlete: entry.athlete?.displayName || "",
          value: entry.displayValue || "",
          team: entry.athlete?.team?.abbreviation || "",
        })),
      });
      continue;
    }
    // Team-grouped: each block has team + categories of leaders
    const teamAbbr = block.team?.abbreviation || "";
    for (const cat of block.leaders || []) {
      const category = cat.displayName || cat.name || "";
      const leaders = (cat.leaders || []).slice(0, 2).map((entry) => ({
        athlete: entry.athlete?.displayName || "",
        value: entry.displayValue || "",
        team: teamAbbr,
      }));
      if (!leaders.length) continue;
      const existing = out.find((row) => row.category === category);
      if (existing) existing.leaders.push(...leaders);
      else out.push({ category, leaders });
    }
  }
  return out.slice(0, 8);
}

function extractTeamStats(summary) {
  return (summary.boxscore?.teams || []).map((entry) => {
    const team = entry.team || {};
    // Game boxscore uses statistics[] with label/displayValue.
    // Pre-game may nest season categories — flatten useful batting/pitching rows.
    let stats = [];
    for (const stat of entry.statistics || []) {
      if (stat.label && stat.displayValue !== undefined && !stat.stats) {
        stats.push({
          label: stat.label || stat.name || "",
          value: String(stat.displayValue ?? ""),
        });
      } else if (Array.isArray(stat.stats)) {
        for (const nested of stat.stats.slice(0, 12)) {
          stats.push({
            label: `${stat.displayName || stat.name || ""} ${nested.abbreviation || nested.shortDisplayName || nested.name || ""}`.trim(),
            value: String(nested.displayValue ?? nested.value ?? ""),
          });
        }
      }
    }
    // Prefer a short, readable set.
    stats = stats.filter((row) => row.label && row.value).slice(0, 14);
    return {
      team: team.displayName || "",
      abbreviation: team.abbreviation || "",
      logo: team.logo || null,
      stats,
    };
  });
}

function extractGameInjuries(summary, leagueInjuries, awayName, homeName) {
  const fromSummary = [];
  for (const bucket of summary.injuries || []) {
    const teamName = bucket.team?.displayName || "";
    const abbr = bucket.team?.abbreviation || "";
    for (const inj of bucket.injuries || []) {
      const row = compactInjury(inj, abbr || teamName);
      if (row) fromSummary.push(row);
    }
  }
  if (fromSummary.length) return fromSummary;

  const merged = [];
  for (const name of [awayName, homeName]) {
    const key = normalizeName(name);
    const bucket = leagueInjuries.get(key);
    if (bucket) merged.push(...bucket.injuries);
    else {
      for (const [teamKey, bucket] of leagueInjuries) {
        if (teamsMatch(name, bucket.team) || teamsMatch(name, teamKey)) {
          merged.push(...bucket.injuries);
          break;
        }
      }
    }
  }
  return merged;
}

function matchOddsEvent(game, oddsEvents) {
  const espnNames = [game.away?.name, game.home?.name].filter(Boolean);
  for (const eventName of oddsEvents) {
    const boltTeams = parseBoltTeams(eventName);
    if (boltTeams.length !== 2) continue;
    const matched =
      espnNames.every((espnName) =>
        boltTeams.some((boltName) => teamsMatch(espnName, boltName)),
      ) ||
      boltTeams.every((boltName) =>
        espnNames.some((espnName) => teamsMatch(espnName, boltName)),
      );
    if (matched) return eventName;
  }
  return null;
}

async function buildLiveBoard(oddsEvents = []) {
  const [games, leagueInjuries] = await Promise.all([
    getScoreboard(),
    getLeagueInjuries(),
  ]);

  return {
    fetchedAt: new Date().toISOString(),
    source: "ESPN (sports-leader-mcp endpoints)",
    games: games.map((game) => {
      const matchedEvent = matchOddsEvent(game, oddsEvents);
      const awayInj =
        [...leagueInjuries.values()].find(
          (bucket) =>
            teamsMatch(game.away?.name, bucket.team) ||
            bucket.abbreviation === game.away?.abbreviation,
        )?.injuries?.length || 0;
      const homeInj =
        [...leagueInjuries.values()].find(
          (bucket) =>
            teamsMatch(game.home?.name, bucket.team) ||
            bucket.abbreviation === game.home?.abbreviation,
        )?.injuries?.length || 0;
      return {
        ...game,
        matchedEvent,
        injuryCount: awayInj + homeInj,
      };
    }),
  };
}

async function buildGameDetail(eventId, oddsEvents = [], { fresh = false } = {}) {
  const [summary, plays, leagueInjuries, board] = await Promise.all([
    getGameSummary(eventId, { fresh }),
    getGamePlays(eventId, fresh ? 400 : 100, { fresh }),
    getLeagueInjuries(),
    getScoreboard({ fresh }),
  ]);

  const game =
    board.find((entry) => entry.id === String(eventId)) ||
    (() => {
      const competition = summary.header?.competitions?.[0];
      const competitors = (competition?.competitors || []).map(compactCompetitor);
      return {
        id: String(eventId),
        name: summary.header?.competitions?.[0]
          ? `${competitors.find((c) => c.homeAway === "away")?.name || "Away"} at ${
              competitors.find((c) => c.homeAway === "home")?.name || "Home"
            }`
          : `Game ${eventId}`,
        shortName: "",
        date: competition?.date || null,
        status: compactStatus(competition?.status || summary.header?.status),
        venue: summary.gameInfo?.venue?.fullName || null,
        away: competitors.find((c) => c.homeAway === "away") || null,
        home: competitors.find((c) => c.homeAway === "home") || null,
        competitors,
      };
    })();

  // Prefer core plays; fall back to summary.plays if present.
  let playList = plays;
  if (!playList.length && Array.isArray(summary.plays)) {
    playList = summary.plays.map(compactPlay).filter((play) => play.text);
  }
  // Newest first for the live UI; keep full history when fresh (scraper).
  playList = [...playList].reverse();
  if (!fresh) playList = playList.slice(0, 40);

  const injuries = extractGameInjuries(
    summary,
    leagueInjuries,
    game.away?.name,
    game.home?.name,
  );

  const winProb = Array.isArray(summary.winprobability)
    ? summary.winprobability.slice(-1)[0]
    : null;

  return {
    fetchedAt: new Date().toISOString(),
    source: "ESPN (sports-leader-mcp endpoints)",
    game: {
      ...game,
      matchedEvent: matchOddsEvent(game, oddsEvents),
    },
    plays: playList,
    leaders: extractLeaders(summary),
    teamStats: extractTeamStats(summary),
    injuries,
    winProbability: winProb
      ? {
          homeWinPct: winProb.homeWinPercentage ?? null,
          tiePct: winProb.tiePercentage ?? null,
        }
      : null,
    situation: summary.situation || null,
    notes: (summary.notes || []).slice(0, 5).map((note) => note.headline || note.text || "").filter(Boolean),
  };
}

module.exports = {
  buildLiveBoard,
  buildGameDetail,
  getScoreboard,
  getGamePlays,
  getGameSummary,
  getLeagueInjuries,
  parseBoltTeams,
  teamsMatch,
  espnFetch,
};
