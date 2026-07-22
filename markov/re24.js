// League-average run expectancy (RE24) and Poisson helpers for live inning pricing.
// Approach mirrors WalrusQuant/mlb-markov: 24 active base-out states → expected runs.
// Values approximate modern MLB league averages (used until season matrices are bootstrapped).

const BASE_KEYS = ["000", "100", "010", "001", "110", "101", "011", "111"];

/** RE24[outs][bases] — expected runs from this state to end of half-inning. */
const RE24 = {
  0: {
    "000": 0.481,
    "100": 0.859,
    "010": 1.1,
    "001": 1.35,
    "110": 1.437,
    "101": 1.784,
    "011": 1.96,
    "111": 2.373,
  },
  1: {
    "000": 0.254,
    "100": 0.504,
    "010": 0.664,
    "001": 0.95,
    "110": 0.903,
    "101": 1.149,
    "011": 1.376,
    "111": 1.533,
  },
  2: {
    "000": 0.098,
    "100": 0.214,
    "010": 0.305,
    "001": 0.356,
    "110": 0.429,
    "101": 0.478,
    "011": 0.58,
    "111": 0.751,
  },
};

function basesKey({ onFirst = false, onSecond = false, onThird = false } = {}) {
  return `${onFirst ? "1" : "0"}${onSecond ? "1" : "0"}${onThird ? "1" : "0"}`;
}

function expectedRunsFromState(outs, bases) {
  const o = Math.min(2, Math.max(0, Number(outs) || 0));
  const key = typeof bases === "string" ? bases : basesKey(bases || {});
  return RE24[o]?.[key] ?? RE24[o]?.["000"] ?? 0.25;
}

function freshHalfExpected() {
  return expectedRunsFromState(0, "000");
}

function factorial(n) {
  let x = 1;
  for (let i = 2; i <= n; i += 1) x *= i;
  return x;
}

function poissonPmf(k, lambda) {
  if (k < 0) return 0;
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return (Math.exp(-lambda) * lambda ** k) / factorial(k);
}

function poissonCdf(k, lambda) {
  let sum = 0;
  const max = Math.max(0, Math.floor(k));
  for (let i = 0; i <= max; i += 1) sum += poissonPmf(i, lambda);
  return Math.min(1, sum);
}

/** P(R > line) for .5 totals when R ~ Poisson(lambda). */
function poissonOverProb(line, lambda) {
  if (!Number.isFinite(line) || !Number.isFinite(lambda)) return null;
  // Over 1.5 → need R >= 2 → 1 - F(1)
  const threshold = Math.floor(line);
  return 1 - poissonCdf(threshold, Math.max(0, lambda));
}

function probabilityToAmerican(probability) {
  if (!Number.isFinite(probability)) return null;
  if (probability <= 0) return "+9900";
  if (probability >= 1) return "-9900";
  const value =
    probability >= 0.5
      ? -Math.round((probability / (1 - probability)) * 100)
      : Math.round(((1 - probability) / probability) * 100);
  return value > 0 ? `+${value}` : String(value);
}

function americanToImplied(price) {
  const value = Number(String(price).replace(/[+−]/g, (m) => (m === "−" ? "-" : "")));
  if (!Number.isFinite(value) || value === 0) return null;
  return value > 0 ? 100 / (value + 100) : Math.abs(value) / (Math.abs(value) + 100);
}

/** Independent Poissons → P(a>b), P(b>a), P(tie). */
function skellamSplit(lambdaA, lambdaB, maxRuns = 12) {
  let pAway = 0;
  let pHome = 0;
  let pTie = 0;
  for (let a = 0; a <= maxRuns; a += 1) {
    const pa = poissonPmf(a, Math.max(0, lambdaA));
    for (let b = 0; b <= maxRuns; b += 1) {
      const p = pa * poissonPmf(b, Math.max(0, lambdaB));
      if (a > b) pAway += p;
      else if (b > a) pHome += p;
      else pTie += p;
    }
  }
  const norm = pAway + pHome + pTie || 1;
  return { pAway: pAway / norm, pHome: pHome / norm, pTie: pTie / norm };
}

module.exports = {
  BASE_KEYS,
  RE24,
  basesKey,
  expectedRunsFromState,
  freshHalfExpected,
  poissonPmf,
  poissonCdf,
  poissonOverProb,
  probabilityToAmerican,
  americanToImplied,
  skellamSplit,
};
