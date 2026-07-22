// Bill James Pythagorean Expectation + log5 — port of WalrusQuant/mlb-pe model.rs
// https://github.com/WalrusQuant/mlb-pe

const STARTER_SHARE = 0.6;
const MIN_IP_FOR_ADJUSTMENT = 20;
const HOME_FIELD_LOG_ODDS = 0.1603; // ~54% home win at coin flip
const RECENT_FORM_WINDOW = 20;
const RECENT_FORM_WEIGHT = 0.4; // 40% L20, 60% season
const MIN_RECENT_GAMES = 10;

function pythagWinPct(rs, ra, exponent) {
  const num = Math.pow(rs, exponent);
  const denom = num + Math.pow(ra, exponent);
  return denom === 0 ? 0.5 : num / denom;
}

function log5(pA, pB) {
  const num = pA * (1 - pB);
  const denom = num + (1 - pA) * pB;
  return denom === 0 ? 0.5 : num / denom;
}

function probToAmerican(p) {
  if (!(p > 0 && p < 1)) return null;
  if (p > 0.5) return String(Math.round((-100 * p) / (1 - p)));
  const dog = Math.round(((1 - p) * 100) / p);
  return `+${dog}`;
}

function americanToDecimal(price) {
  const value = Number(String(price).replace(/[+−]/g, (m) => (m === "−" ? "-" : "")));
  if (!Number.isFinite(value) || value === 0) return null;
  return value > 0 ? 1 + value / 100 : 1 + 100 / Math.abs(value);
}

function americanToImplied(price) {
  const value = Number(String(price).replace(/[+−]/g, (m) => (m === "−" ? "-" : "")));
  if (!Number.isFinite(value) || value === 0) return null;
  return value > 0 ? 100 / (value + 100) : Math.abs(value) / (Math.abs(value) + 100);
}

function shiftLogOdds(p, delta) {
  const clamped = Math.min(1 - 1e-9, Math.max(1e-9, p));
  const lo = Math.log(clamped / (1 - clamped)) + delta;
  return 1 / (1 + Math.exp(-lo));
}

function blend(seasonPerG, recentRate, recentGames, weight = RECENT_FORM_WEIGHT) {
  if (recentRate == null || recentGames == null || recentGames < MIN_RECENT_GAMES) {
    return seasonPerG;
  }
  return weight * recentRate + (1 - weight) * seasonPerG;
}

function applyPitcher(teamRaPg, pitcher) {
  if (!pitcher || !(pitcher.inningsPitched >= MIN_IP_FOR_ADJUSTMENT)) return teamRaPg;
  return STARTER_SHARE * pitcher.era + (1 - STARTER_SHARE) * teamRaPg;
}

function roundTo(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function poissonPmf(k, lambda) {
  if (k < 0) return 0;
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let fact = 1;
  for (let i = 2; i <= k; i += 1) fact *= i;
  return (Math.exp(-lambda) * lambda ** k) / fact;
}

function poissonOverProb(line, lambda) {
  if (!Number.isFinite(line) || !Number.isFinite(lambda)) return null;
  let cdf = 0;
  const max = Math.floor(line);
  for (let i = 0; i <= max; i += 1) cdf += poissonPmf(i, Math.max(0, lambda));
  return 1 - Math.min(1, cdf);
}

function skellamHomeCover(lambdaAway, lambdaHome, spreadAbs, maxRuns = 14) {
  // P(home_runs - away_runs > spreadAbs) for home favorite negative spread magnitude
  let pCover = 0;
  let mass = 0;
  const need = Math.ceil(spreadAbs); // -1.5 → need margin >= 2
  for (let a = 0; a <= maxRuns; a += 1) {
    for (let h = 0; h <= maxRuns; h += 1) {
      const p =
        poissonPmf(a, Math.max(0, lambdaAway)) *
        poissonPmf(h, Math.max(0, lambdaHome));
      mass += p;
      if (h - a >= need) pCover += p;
    }
  }
  return mass > 0 ? pCover / mass : 0.5;
}

/** Home/away win probs from projected runs (Skellam). Ties split 50/50 for ML pricing. */
function skellamWinProbs(lambdaAway, lambdaHome, maxRuns = 16) {
  let pHome = 0;
  let pAway = 0;
  let pTie = 0;
  let mass = 0;
  const la = Math.max(0, lambdaAway);
  const lh = Math.max(0, lambdaHome);
  for (let a = 0; a <= maxRuns; a += 1) {
    for (let h = 0; h <= maxRuns; h += 1) {
      const p = poissonPmf(a, la) * poissonPmf(h, lh);
      mass += p;
      if (h > a) pHome += p;
      else if (a > h) pAway += p;
      else pTie += p;
    }
  }
  if (!(mass > 0)) return { homeWin: 0.5, awayWin: 0.5 };
  const homeWin = (pHome + 0.5 * pTie) / mass;
  return { homeWin, awayWin: 1 - homeWin };
}

/**
 * Fit Pythagorean exponent by golden-section search minimizing MSE of
 * predicted vs actual win% (same idea as mlb-pe optimize_exponent).
 */
function optimizeExponent(teamRows) {
  const teams = teamRows.filter((t) => t.gamesPlayed >= 10);
  if (teams.length < 2) return 2.0;

  function mse(exp) {
    let err = 0;
    for (const t of teams) {
      const pred = pythagWinPct(t.runsScored, t.runsAllowed, exp);
      const actual = t.wins / Math.max(1, t.wins + t.losses);
      err += (pred - actual) ** 2;
    }
    return err / teams.length;
  }

  let lo = 0.5;
  let hi = 5.0;
  const phi = (Math.sqrt(5) - 1) / 2;
  let x1 = hi - phi * (hi - lo);
  let x2 = lo + phi * (hi - lo);
  let f1 = mse(x1);
  let f2 = mse(x2);
  for (let i = 0; i < 40; i += 1) {
    if (f1 < f2) {
      hi = x2;
      x2 = x1;
      f2 = f1;
      x1 = hi - phi * (hi - lo);
      f1 = mse(x1);
    } else {
      lo = x1;
      x1 = x2;
      f1 = f2;
      x2 = lo + phi * (hi - lo);
      f2 = mse(x2);
    }
  }
  return roundTo((lo + hi) / 2, 4);
}

function estimateGame({
  home,
  away,
  lgAvgRuns,
  homePitcher = null,
  awayPitcher = null,
  exponent = 2,
  applyHomeField = true,
  applyRecentForm = true,
  applyPitcherAdj = true,
} = {}) {
  const homeSeasonRs = home.gamesPlayed > 0 ? home.runsScored / home.gamesPlayed : 4.5;
  const awaySeasonRs = away.gamesPlayed > 0 ? away.runsScored / away.gamesPlayed : 4.5;
  const homeSeasonRa = home.gamesPlayed > 0 ? home.runsAllowed / home.gamesPlayed : 4.5;
  const awaySeasonRa = away.gamesPlayed > 0 ? away.runsAllowed / away.gamesPlayed : 4.5;

  const homeRs = applyRecentForm
    ? blend(homeSeasonRs, home.recentRsPerGame, home.recentGames)
    : homeSeasonRs;
  const awayRs = applyRecentForm
    ? blend(awaySeasonRs, away.recentRsPerGame, away.recentGames)
    : awaySeasonRs;
  const homeRaTeam = applyRecentForm
    ? blend(homeSeasonRa, home.recentRaPerGame, home.recentGames)
    : homeSeasonRa;
  const awayRaTeam = applyRecentForm
    ? blend(awaySeasonRa, away.recentRaPerGame, away.recentGames)
    : awaySeasonRa;

  const homeRaEff = applyPitcherAdj ? applyPitcher(homeRaTeam, homePitcher) : homeRaTeam;
  const awayRaEff = applyPitcherAdj ? applyPitcher(awayRaTeam, awayPitcher) : awayRaTeam;

  const homePyt = pythagWinPct(homeRs, homeRaEff, exponent);
  const awayPyt = pythagWinPct(awayRs, awayRaEff, exponent);

  const homeOs = homeRs / lgAvgRuns;
  const awayOs = awayRs / lgAvgRuns;
  const homeDs = homeRaEff / lgAvgRuns;
  const awayDs = awayRaEff / lgAvgRuns;
  const homePred = homeOs * awayDs * lgAvgRuns;
  const awayPred = awayOs * homeDs * lgAvgRuns;
  const totalPred = homePred + awayPred;

  let homeWin = Math.min(1 - 1e-9, Math.max(1e-9, log5(homePyt, awayPyt)));
  if (applyHomeField) homeWin = shiftLogOdds(homeWin, HOME_FIELD_LOG_ODDS);
  const awayWin = 1 - homeWin;

  return {
    homeWinProb: roundTo(homeWin, 4),
    awayWinProb: roundTo(awayWin, 4),
    homeFairOdds: probToAmerican(homeWin),
    awayFairOdds: probToAmerican(awayWin),
    homePredRuns: roundTo(homePred, 2),
    awayPredRuns: roundTo(awayPred, 2),
    totalPredRuns: roundTo(totalPred, 2),
    exponent: roundTo(exponent, 4),
    lgAvgRuns: roundTo(lgAvgRuns, 3),
    homePitcherApplied: Boolean(
      applyPitcherAdj && homePitcher && homePitcher.inningsPitched >= MIN_IP_FOR_ADJUSTMENT,
    ),
    awayPitcherApplied: Boolean(
      applyPitcherAdj && awayPitcher && awayPitcher.inningsPitched >= MIN_IP_FOR_ADJUSTMENT,
    ),
  };
}

/** Turn projected runs into fair ML / spread / total prices, then EV vs books. */
function attachMarketEv(prediction, books = {}) {
  const homeMlDec = americanToDecimal(books.homeMl);
  const awayMlDec = americanToDecimal(books.awayMl);
  const overDec = americanToDecimal(books.over);
  const underDec = americanToDecimal(books.under);
  const homeSpreadDec = americanToDecimal(books.homeSpread);
  const awaySpreadDec = americanToDecimal(books.awaySpread);

  const awayRuns = Number(prediction.awayPredRuns);
  const homeRuns = Number(prediction.homePredRuns);
  const totalPred = Number(prediction.totalPredRuns);

  // Moneyline from projected score (Skellam on team λs) — same score model as spread/total.
  const { homeWin, awayWin } = skellamWinProbs(awayRuns, homeRuns);
  const homeFairOdds = probToAmerican(homeWin);
  const awayFairOdds = probToAmerican(awayWin);

  const totalLine =
    books.totalLine != null && books.totalLine !== ""
      ? Number(books.totalLine)
      : Math.round(totalPred * 2) / 2;
  const pOver = poissonOverProb(totalLine, totalPred);
  const pUnder = pOver == null ? null : 1 - pOver;

  const spreadAbs =
    books.spreadAbs != null && Number.isFinite(Number(books.spreadAbs))
      ? Math.abs(Number(books.spreadAbs))
      : 1.5;
  // P(home covers −spreadAbs), i.e. home wins by 2+ for −1.5
  const pHomeSpread = skellamHomeCover(awayRuns, homeRuns, spreadAbs);
  const pAwaySpread = 1 - pHomeSpread;

  function side(fairProb, fairPrice, bookPrice, book, decimal) {
    const edge =
      fairProb == null || decimal == null
        ? null
        : roundTo(fairProb * decimal - 1, 4);
    return {
      fairPrice,
      fairProb,
      bookPrice: bookPrice || "",
      book: book || "",
      edge,
      ev: edge,
    };
  }

  return {
    ...prediction,
    // Keep score-based ML as the market fair (overrides pythag/log5 display odds).
    homeWinProb: roundTo(homeWin, 4),
    awayWinProb: roundTo(awayWin, 4),
    homeFairOdds,
    awayFairOdds,
    moneyline: {
      away: side(roundTo(awayWin, 4), awayFairOdds, books.awayMl, books.awayMlBook, awayMlDec),
      home: side(roundTo(homeWin, 4), homeFairOdds, books.homeMl, books.homeMlBook, homeMlDec),
    },
    spread: {
      line: spreadAbs,
      away: side(
        roundTo(pAwaySpread, 4),
        probToAmerican(pAwaySpread),
        books.awaySpread,
        books.awaySpreadBook,
        awaySpreadDec,
      ),
      home: side(
        roundTo(pHomeSpread, 4),
        probToAmerican(pHomeSpread),
        books.homeSpread,
        books.homeSpreadBook,
        homeSpreadDec,
      ),
    },
    total: {
      line: totalLine,
      over: side(
        pOver == null ? null : roundTo(pOver, 4),
        probToAmerican(pOver),
        books.over,
        books.overBook,
        overDec,
      ),
      under: side(
        pUnder == null ? null : roundTo(pUnder, 4),
        probToAmerican(pUnder),
        books.under,
        books.underBook,
        underDec,
      ),
    },
  };
}

module.exports = {
  STARTER_SHARE,
  MIN_IP_FOR_ADJUSTMENT,
  HOME_FIELD_LOG_ODDS,
  RECENT_FORM_WINDOW,
  RECENT_FORM_WEIGHT,
  pythagWinPct,
  log5,
  probToAmerican,
  americanToImplied,
  shiftLogOdds,
  blend,
  applyPitcher,
  optimizeExponent,
  estimateGame,
  attachMarketEv,
  skellamWinProbs,
  skellamHomeCover,
  roundTo,
};
