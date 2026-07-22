// Fair prices for Nth Inning Moneyline / Spread / Total from live base-out state.
// Uses league RE24 (Markov half-inning expectancy) + Poisson remaining-run model.

const {
  expectedRunsFromState,
  freshHalfExpected,
  basesKey,
  poissonOverProb,
  poissonPmf,
  probabilityToAmerican,
  americanToImplied,
  skellamSplit,
} = require("./re24");

const INNING_ORDINALS = ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th"];

function inningMarketName(inning, kind) {
  const ordinal = INNING_ORDINALS[inning - 1];
  if (!ordinal) return null;
  return `${ordinal} Inning ${kind}`;
}

/**
 * @param {object} situation
 * @param {number} situation.inning
 * @param {'Top'|'Bottom'|'Mid'|'Complete'|'Pre'} situation.half
 * @param {number} situation.outs
 * @param {boolean} situation.onFirst
 * @param {boolean} situation.onSecond
 * @param {boolean} situation.onThird
 * @param {number} situation.awayRunsThisInning
 * @param {number} situation.homeRunsThisInning
 * @param {number} [situation.activeInning] current game inning
 */
function expectedHalfLambdas(situation, targetInning) {
  const active = Number(situation.activeInning || situation.inning || 0);
  const half = situation.half || "Pre";
  const outs = Number(situation.outs) || 0;
  const bases = basesKey(situation);
  const awayScored = Number(situation.awayRunsThisInning) || 0;
  const homeScored = Number(situation.homeRunsThisInning) || 0;
  const fresh = freshHalfExpected();

  // Future inning not started yet
  if (targetInning > active || (targetInning === active && half === "Pre")) {
    return { lambdaAway: fresh, lambdaHome: fresh, status: "upcoming" };
  }

  // Past completed inning — caller should pass known finals when available
  if (targetInning < active || half === "Complete") {
    return {
      lambdaAway: awayScored,
      lambdaHome: homeScored,
      status: "final",
      known: true,
    };
  }

  // Current inning
  if (half === "Top") {
    return {
      lambdaAway: awayScored + expectedRunsFromState(outs, bases),
      lambdaHome: fresh,
      status: "live-top",
    };
  }
  if (half === "Mid") {
    return {
      lambdaAway: awayScored,
      lambdaHome: fresh,
      status: "mid",
    };
  }
  if (half === "Bottom") {
    return {
      lambdaAway: awayScored,
      lambdaHome: homeScored + expectedRunsFromState(outs, bases),
      status: "live-bottom",
    };
  }

  return { lambdaAway: fresh, lambdaHome: fresh, status: "upcoming" };
}

function priceInningMarkets(situation, targetInning, bookSides = {}) {
  const lambdas = expectedHalfLambdas(situation, targetInning);
  const { lambdaAway, lambdaHome, status, known } = lambdas;
  const lambdaTotal = Math.max(0, lambdaAway) + Math.max(0, lambdaHome);

  let pAwayMl;
  let pHomeMl;
  let pOver;
  let pUnder;
  let pAwaySpread;
  let pHomeSpread;

  if (known) {
    const a = Math.round(lambdaAway);
    const h = Math.round(lambdaHome);
    if (a === h) {
      pAwayMl = 0.5;
      pHomeMl = 0.5;
    } else {
      pAwayMl = a > h ? 1 : 0;
      pHomeMl = h > a ? 1 : 0;
    }
    const totalLineKnown =
      bookSides.totalLine != null && bookSides.totalLine !== ""
        ? Number(bookSides.totalLine)
        : 0.5;
    pOver = a + h > totalLineKnown ? 1 : 0;
    pUnder = 1 - pOver;
    const spreadAbsKnown =
      bookSides.spreadAbs != null && Number.isFinite(Number(bookSides.spreadAbs))
        ? Math.abs(Number(bookSides.spreadAbs))
        : 0.5;
    pHomeSpread = h - a >= Math.ceil(spreadAbsKnown) ? 1 : 0;
    pAwaySpread = a - h >= Math.ceil(spreadAbsKnown) ? 1 : 0;
    if (pHomeSpread === 0 && pAwaySpread === 0) {
      pHomeSpread = 0.5;
      pAwaySpread = 0.5;
    }
  } else {
    const split = skellamSplit(lambdaAway, lambdaHome);
    const denom = 1 - split.pTie || 1;
    pAwayMl = split.pAway / denom;
    pHomeMl = split.pHome / denom;

    const totalLine =
      bookSides.totalLine != null && bookSides.totalLine !== ""
        ? Number(bookSides.totalLine)
        : 0.5;
    pOver = poissonOverProb(totalLine, lambdaTotal);
    pUnder = pOver == null ? null : 1 - pOver;

    const spreadAbs =
      bookSides.spreadAbs != null && Number.isFinite(Number(bookSides.spreadAbs))
        ? Math.abs(Number(bookSides.spreadAbs))
        : 0.5;

    pAwaySpread = pAwayMl;
    pHomeSpread = pHomeMl;
    if (spreadAbs >= 1.5) {
      const maxRuns = 12;
      let pHomeCover = 0;
      let pAwayCover = 0;
      let mass = 0;
      for (let a = 0; a <= maxRuns; a += 1) {
        for (let b = 0; b <= maxRuns; b += 1) {
          const p =
            poissonPmf(a, Math.max(0, lambdaAway)) *
            poissonPmf(b, Math.max(0, lambdaHome));
          mass += p;
          if (b - a >= Math.ceil(spreadAbs)) pHomeCover += p;
          if (a - b >= Math.ceil(spreadAbs)) pAwayCover += p;
        }
      }
      if (mass > 0) {
        pHomeSpread = pHomeCover / mass;
        pAwaySpread = pAwayCover / mass;
        const pushMass = 1 - pHomeSpread - pAwaySpread;
        const d = 1 - Math.max(0, pushMass) || 1;
        pHomeSpread /= d;
        pAwaySpread /= d;
      }
    }
  }

  const totalLine =
    bookSides.totalLine != null && bookSides.totalLine !== ""
      ? Number(bookSides.totalLine)
      : 0.5;
  const spreadAbs =
    bookSides.spreadAbs != null && Number.isFinite(Number(bookSides.spreadAbs))
      ? Math.abs(Number(bookSides.spreadAbs))
      : 0.5;

  function edge(modelProb, bookPrice) {
    const implied = americanToImplied(bookPrice);
    if (modelProb == null || implied == null) return null;
    return modelProb - implied;
  }

  const model = {
    inning: targetInning,
    status,
    lambdaAway: Math.round(lambdaAway * 1000) / 1000,
    lambdaHome: Math.round(lambdaHome * 1000) / 1000,
    lambdaTotal: Math.round(lambdaTotal * 1000) / 1000,
    state: {
      outs: situation.outs ?? null,
      bases: basesKey(situation),
      half: situation.half,
      reRemaining: known
        ? 0
        : expectedRunsFromState(situation.outs || 0, situation),
    },
    moneyline: {
      away: {
        fairPrice: probabilityToAmerican(pAwayMl),
        fairProb: pAwayMl,
        bookPrice: bookSides.awayMl || "",
        edge: edge(pAwayMl, bookSides.awayMl),
      },
      home: {
        fairPrice: probabilityToAmerican(pHomeMl),
        fairProb: pHomeMl,
        bookPrice: bookSides.homeMl || "",
        edge: edge(pHomeMl, bookSides.homeMl),
      },
    },
    spread: {
      line: spreadAbs,
      away: {
        fairPrice: probabilityToAmerican(pAwaySpread),
        fairProb: pAwaySpread,
        bookPrice: bookSides.awaySpread || "",
        edge: edge(pAwaySpread, bookSides.awaySpread),
      },
      home: {
        fairPrice: probabilityToAmerican(pHomeSpread),
        fairProb: pHomeSpread,
        bookPrice: bookSides.homeSpread || "",
        edge: edge(pHomeSpread, bookSides.homeSpread),
      },
    },
    total: {
      line: totalLine,
      over: {
        fairPrice: probabilityToAmerican(pOver),
        fairProb: pOver,
        bookPrice: bookSides.over || "",
        edge: edge(pOver, bookSides.over),
      },
      under: {
        fairPrice: probabilityToAmerican(pUnder),
        fairProb: pUnder,
        bookPrice: bookSides.under || "",
        edge: edge(pUnder, bookSides.under),
      },
    },
  };

  return model;
}

function buildInningModelBoard(situation, bookByInning = {}) {
  if (!situation?.activeInning && !situation?.inning) return null;
  const active = Number(situation.activeInning || situation.inning);
  const out = {
    methodology:
      "Fair prices from league-average RE24 (Markov half-inning run expectancy) + Poisson remaining runs — same state framework as mlb-markov.",
    situation,
    innings: {},
  };

  for (let n = 1; n <= 9; n += 1) {
    const books = bookByInning[n] || {};
    // Current + future innings always; past only if books still quote.
    if (n < active && !books.awayMl && !books.over && !books.awaySpread) continue;
    out.innings[n] = priceInningMarkets(
      n === active
        ? situation
        : {
            ...situation,
            activeInning: active,
            // For future innings, ignore current base state
            half: n > active ? "Pre" : situation.half,
            outs: n > active ? 0 : situation.outs,
            onFirst: n > active ? false : situation.onFirst,
            onSecond: n > active ? false : situation.onSecond,
            onThird: n > active ? false : situation.onThird,
            awayRunsThisInning: n === active ? situation.awayRunsThisInning : 0,
            homeRunsThisInning: n === active ? situation.homeRunsThisInning : 0,
          },
      n,
      books,
    );
  }
  return out;
}

module.exports = {
  INNING_ORDINALS,
  inningMarketName,
  expectedHalfLambdas,
  priceInningMarkets,
  buildInningModelBoard,
};
