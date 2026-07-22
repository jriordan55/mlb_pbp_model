// Drop alternate / non-mainline MLB spreads from odds + arbs.

function isAlternateMarketName(name) {
  return /\balternate\b|\balt[\s._-]?spreads?\b/i.test(String(name || ""));
}

function isGameSpread(row) {
  const cat = String(row?.category || row?.market || "");
  if (!cat) return false;
  if (/inning/i.test(cat)) return false;
  return cat === "Spread" || /^spread$/i.test(cat);
}

/** Per-event main run line = most common |line|; ties prefer 1.5 then smaller. */
function mainSpreadAbsByEvent(odds) {
  const counts = new Map();
  for (const odd of odds || []) {
    if (!isGameSpread(odd)) continue;
    if (isAlternateMarketName(odd.market) || isAlternateMarketName(odd.category)) {
      continue;
    }
    const abs = Math.abs(Number(odd.line));
    if (!Number.isFinite(abs)) continue;
    const key = odd.eventKey || odd.event;
    if (!key) continue;
    if (!counts.has(key)) counts.set(key, new Map());
    const m = counts.get(key);
    m.set(abs, (m.get(abs) || 0) + 1);
  }

  const main = new Map();
  for (const [event, m] of counts) {
    let bestLine = null;
    let bestCount = -1;
    for (const [line, c] of m) {
      const better =
        c > bestCount ||
        (c === bestCount &&
          (line === 1.5 || (bestLine !== 1.5 && line < bestLine)));
      if (better) {
        bestLine = line;
        bestCount = c;
      }
    }
    if (bestLine != null) main.set(event, bestLine);
  }
  return main;
}

function isAlternateSpreadRow(row, mainByEvent) {
  if (isAlternateMarketName(row?.market) || isAlternateMarketName(row?.category)) {
    return true;
  }
  if (!isGameSpread(row)) return false;
  const abs = Math.abs(Number(row.line));
  if (!Number.isFinite(abs)) return false;
  const key = row.eventKey || row.event;
  const mainLine = mainByEvent?.get(key);
  if (Number.isFinite(mainLine)) return abs !== mainLine;
  // Fallback when we can't infer: keep classic MLB run line only.
  return abs !== 1.5;
}

function dropAlternateSpreads(odds = [], arbs = []) {
  const named = (odds || []).filter(
    (odd) =>
      !isAlternateMarketName(odd.market) &&
      !isAlternateMarketName(odd.category),
  );
  const mainByEvent = mainSpreadAbsByEvent(named);
  const oddsOut = named.filter((odd) => !isAlternateSpreadRow(odd, mainByEvent));
  const arbsOut = (arbs || []).filter(
    (arb) => !isAlternateSpreadRow(arb, mainByEvent),
  );
  return { odds: oddsOut, arbs: arbsOut, mainByEvent };
}

module.exports = {
  isAlternateMarketName,
  isGameSpread,
  mainSpreadAbsByEvent,
  isAlternateSpreadRow,
  dropAlternateSpreads,
};
