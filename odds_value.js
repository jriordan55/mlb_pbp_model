// Shared +EV / arb detection from flat BoltOdds quote rows (scraper + Actions).

const { dropAlternateSpreads } = require("./market_filters");

const MAX_AMERICAN_ODDS = 1000;

// Telegram alerts are limited to these player-prop markets.
const PROP_ALERT_MARKETS = new Set([
  "Hits",
  "Home Runs",
  "RBIs",
  "Runs",
  "Bases",
  "Hits + Runs + RBIs",
  "Strikeouts Thrown",
  "Outs",
]);

const BOOK_LABELS = {
  fanduel: "FanDuel",
  draftkings: "DraftKings",
  betmgm: "BetMGM",
  betonline: "BetOnline",
  thescore: "theScore",
  consensus: "Consensus",
};

function bookLabel(id) {
  return BOOK_LABELS[id] || String(id || "").charAt(0).toUpperCase() + String(id || "").slice(1);
}

function parseAmerican(price) {
  const value = Number(String(price).replace(/[+−]/g, (match) => (match === "−" ? "-" : "")));
  return Number.isFinite(value) && value !== 0 ? value : null;
}

function americanToDecimal(price) {
  const value = parseAmerican(price);
  if (value === null) return null;
  return value > 0 ? 1 + value / 100 : 1 + 100 / Math.abs(value);
}

function probabilityToAmerican(probability) {
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) return null;
  const value =
    probability >= 0.5
      ? -Math.round((probability / (1 - probability)) * 100)
      : Math.round(((1 - probability) / probability) * 100);
  return value > 0 ? `+${value}` : String(value);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalizedSide(side) {
  if (/^(o|over)$/i.test(side || "")) return "Over";
  if (/^(u|under)$/i.test(side || "")) return "Under";
  return side || null;
}

function toQuote(row) {
  const american = parseAmerican(row.odds);
  const decimal = americanToDecimal(row.odds);
  if (!decimal || american === null || american > MAX_AMERICAN_ODDS) return null;
  const market = row.market || row.outcome_name || "";
  if (!market) return null;
  const bookId = row.sportsbook || row.sportsbook_id || "";
  if (!bookId || bookId === "consensus") return null;
  const lineRaw = row.line;
  const line =
    lineRaw === null || lineRaw === "" || lineRaw === undefined
      ? null
      : Number(lineRaw);
  return {
    event: (row.game || row.event || "").replace(/,\s*[a-f0-9]{12}$/i, ""),
    market,
    target: row.target || row.outcome_target || null,
    side: normalizedSide(row.side || row.outcome_over_under),
    line: Number.isFinite(line) ? line : null,
    price: row.odds,
    decimal,
    american,
    sportsbook: { id: bookId, name: bookLabel(bookId) },
    link: row.link || null,
  };
}

function findValueFromOddsRows(rows) {
  const rawQuotes = [];
  for (const row of rows || []) {
    const quote = toQuote(row);
    if (quote) rawQuotes.push(quote);
  }

  const overUnderGroups = new Map();
  const spreadGroups = new Map();
  const matchupGroups = new Map();

  for (const quote of rawQuotes) {
    if (quote.side && Number.isFinite(quote.line)) {
      const key = [
        quote.event,
        quote.market,
        quote.target || "game",
        quote.line,
      ].join("|");
      if (!overUnderGroups.has(key)) overUnderGroups.set(key, []);
      overUnderGroups.get(key).push(quote);
    } else if (Number.isFinite(quote.line) && quote.target) {
      const key = [quote.event, quote.market, Math.abs(quote.line)].join("|");
      if (!spreadGroups.has(key)) spreadGroups.set(key, []);
      spreadGroups.get(key).push(quote);
    } else {
      if (!quote.target || quote.target === quote.market) continue;
      const key = `${quote.event}|${quote.market}`;
      if (!matchupGroups.has(key)) matchupGroups.set(key, []);
      matchupGroups.get(key).push(quote);
    }
  }

  const odds = [];

  for (const quotes of overUnderGroups.values()) {
    const sample = quotes[0];
    const byBook = new Map();
    for (const quote of quotes) {
      if (!byBook.has(quote.sportsbook.id)) byBook.set(quote.sportsbook.id, {});
      byBook.get(quote.sportsbook.id)[quote.side] = quote;
    }
    const fairOverByBook = [];
    for (const sides of byBook.values()) {
      if (!sides.Over || !sides.Under) continue;
      const overImplied = 1 / sides.Over.decimal;
      const underImplied = 1 / sides.Under.decimal;
      fairOverByBook.push(overImplied / (overImplied + underImplied));
    }
    const fairOver = median(fairOverByBook);
    if (fairOver === null) continue;

    for (const side of ["Over", "Under"]) {
      const bestByBook = new Map();
      for (const quote of quotes.filter((entry) => entry.side === side)) {
        const existing = bestByBook.get(quote.sportsbook.id);
        if (!existing || quote.decimal > existing.decimal) {
          bestByBook.set(quote.sportsbook.id, quote);
        }
      }
      const sideQuotes = [...bestByBook.values()].sort((a, b) => b.decimal - a.decimal);
      if (!sideQuotes.length) continue;
      const fairProbability = side === "Over" ? fairOver : 1 - fairOver;
      const best = sideQuotes[0];
      odds.push({
        id: `${sample.event}|${sample.market}|${sample.target || "game"}|${sample.line}|${side}`,
        event: sample.event,
        category: sample.market,
        market: sample.market,
        name: sample.target || "Match Total",
        side,
        line: sample.line,
        price: best.price,
        sportsbook: best.sportsbook,
        fairProbability,
        fairPrice: probabilityToAmerican(fairProbability),
        ev: fairProbability * best.decimal - 1,
      });
    }
  }

  for (const quotes of matchupGroups.values()) {
    const sample = quotes[0];
    const byBook = new Map();
    for (const quote of quotes) {
      if (!byBook.has(quote.sportsbook.id)) byBook.set(quote.sportsbook.id, []);
      byBook.get(quote.sportsbook.id).push(quote);
    }
    const fairByTarget = new Map();
    for (const bookQuotes of byBook.values()) {
      const uniqueTargets = new Map();
      for (const quote of bookQuotes) {
        const existing = uniqueTargets.get(quote.target);
        if (!existing || quote.decimal > existing.decimal) {
          uniqueTargets.set(quote.target, quote);
        }
      }
      const sides = [...uniqueTargets.values()];
      const impliedTotal = sides.reduce((sum, quote) => sum + 1 / quote.decimal, 0);
      if (sides.length < 2 || !impliedTotal) continue;
      for (const quote of sides) {
        if (!fairByTarget.has(quote.target)) fairByTarget.set(quote.target, []);
        fairByTarget.get(quote.target).push(1 / quote.decimal / impliedTotal);
      }
    }
    for (const [target, probabilities] of fairByTarget) {
      const bestByBook = new Map();
      for (const quote of quotes.filter((entry) => entry.target === target)) {
        const existing = bestByBook.get(quote.sportsbook.id);
        if (!existing || quote.decimal > existing.decimal) {
          bestByBook.set(quote.sportsbook.id, quote);
        }
      }
      const selectionQuotes = [...bestByBook.values()].sort((a, b) => b.decimal - a.decimal);
      if (!selectionQuotes.length) continue;
      const fairProbability = median(probabilities);
      if (fairProbability === null) continue;
      const best = selectionQuotes[0];
      odds.push({
        id: `${sample.event}|${sample.market}|${target}`,
        event: sample.event,
        category: sample.market,
        market: sample.market,
        name: target,
        side: null,
        line: null,
        price: best.price,
        sportsbook: best.sportsbook,
        fairProbability,
        fairPrice: probabilityToAmerican(fairProbability),
        ev: fairProbability * best.decimal - 1,
      });
    }
  }

  for (const quotes of spreadGroups.values()) {
    const sample = quotes[0];
    const targets = [...new Set(quotes.map((quote) => quote.target).filter(Boolean))];
    if (targets.length !== 2) continue;

    const bySelection = new Map();
    for (const quote of quotes) {
      if (!quote.target || !Number.isFinite(quote.line)) continue;
      const key = `${quote.target}|${quote.line}`;
      if (!bySelection.has(key)) bySelection.set(key, []);
      bySelection.get(key).push(quote);
    }

    for (const selectionQuotesRaw of bySelection.values()) {
      const selectionSample = selectionQuotesRaw[0];
      const target = selectionSample.target;
      const line = selectionSample.line;
      const oppositeTarget = targets.find((name) => name !== target);
      const oppositeLine = -line;

      const bestByBook = new Map();
      for (const quote of selectionQuotesRaw) {
        const existing = bestByBook.get(quote.sportsbook.id);
        if (!existing || quote.decimal > existing.decimal) {
          bestByBook.set(quote.sportsbook.id, quote);
        }
      }
      const selectionQuotes = [...bestByBook.values()].sort((a, b) => b.decimal - a.decimal);
      if (!selectionQuotes.length) continue;

      const fairProbs = [];
      const books = new Set(quotes.map((quote) => quote.sportsbook.id));
      for (const bookId of books) {
        const thisSide = selectionQuotesRaw
          .filter((quote) => quote.sportsbook.id === bookId)
          .sort((a, b) => b.decimal - a.decimal)[0];
        const otherSide = quotes
          .filter(
            (quote) =>
              quote.sportsbook.id === bookId &&
              quote.target === oppositeTarget &&
              quote.line === oppositeLine,
          )
          .sort((a, b) => b.decimal - a.decimal)[0];
        if (!thisSide || !otherSide) continue;
        const thisImplied = 1 / thisSide.decimal;
        const otherImplied = 1 / otherSide.decimal;
        fairProbs.push(thisImplied / (thisImplied + otherImplied));
      }
      const fairProbability = median(fairProbs);
      if (fairProbability === null) continue;
      const best = selectionQuotes[0];
      odds.push({
        id: `${sample.event}|${sample.market}|${target}|${line}`,
        event: sample.event,
        category: sample.market,
        market: sample.market,
        name: target,
        side: null,
        line,
        price: best.price,
        sportsbook: best.sportsbook,
        fairProbability,
        fairPrice: probabilityToAmerican(fairProbability),
        ev: fairProbability * best.decimal - 1,
      });
    }
  }

  const arbs = [];

  function bestCrossBookPair(sidePools, { requireOppositeSpread = false } = {}) {
    if (sidePools.length !== 2) return null;
    const [poolA, poolB] = sidePools.map((pool) =>
      [...pool].sort((a, b) => b.decimal - a.decimal),
    );
    let best = null;
    for (const quoteA of poolA) {
      for (const quoteB of poolB) {
        if (quoteA.sportsbook.id === quoteB.sportsbook.id) continue;
        if (requireOppositeSpread) {
          if (!quoteA.target || !quoteB.target || quoteA.target === quoteB.target) continue;
          if (
            !Number.isFinite(quoteA.line) ||
            !Number.isFinite(quoteB.line) ||
            quoteA.line * quoteB.line >= 0 ||
            Math.abs(quoteA.line) !== Math.abs(quoteB.line)
          ) {
            continue;
          }
        }
        const impliedSum = 1 / quoteA.decimal + 1 / quoteB.decimal;
        if (!(impliedSum > 0 && impliedSum < 1)) continue;
        if (!best || impliedSum < best.impliedSum) {
          best = { sides: [quoteA, quoteB], impliedSum };
        }
        break;
      }
    }
    return best;
  }

  function consider(sidePools, meta, options) {
    const pair = bestCrossBookPair(sidePools, options);
    if (!pair) return;
    const profit = 1 / pair.impliedSum - 1;
    arbs.push({
      id: meta.id,
      event: meta.event,
      category: meta.category,
      market: meta.market,
      line: meta.line ?? null,
      profit,
      legs: pair.sides.map((side) => ({
        name: side.name || side.target,
        target: side.target || side.name,
        side: side.side || null,
        line: side.line ?? null,
        price: side.price,
        sportsbook: side.sportsbook,
      })),
    });
  }

  for (const quotes of overUnderGroups.values()) {
    const sample = quotes[0];
    const pools = { Over: [], Under: [] };
    for (const quote of quotes) {
      if (!pools[quote.side]) continue;
      pools[quote.side].push({
        ...quote,
        name: `${quote.target || "Total"} ${quote.side}`,
      });
    }
    consider([pools.Over, pools.Under], {
      id: `arb|${sample.event}|${sample.market}|${sample.target || "game"}|${sample.line}`,
      event: sample.event,
      category: sample.market,
      market: sample.market,
      line: sample.line,
    });
  }

  for (const quotes of matchupGroups.values()) {
    const sample = quotes[0];
    const byTarget = new Map();
    for (const quote of quotes) {
      if (!quote.target) continue;
      if (!byTarget.has(quote.target)) byTarget.set(quote.target, []);
      byTarget.get(quote.target).push({ ...quote, name: quote.target });
    }
    const targets = [...byTarget.keys()];
    if (targets.length !== 2) continue;
    consider(
      [byTarget.get(targets[0]), byTarget.get(targets[1])],
      {
        id: `arb|${sample.event}|${sample.market}|${targets.join("|")}`,
        event: sample.event,
        category: sample.market,
        market: sample.market,
        line: null,
      },
    );
  }

  for (const quotes of spreadGroups.values()) {
    const sample = quotes[0];
    const byTarget = new Map();
    for (const quote of quotes) {
      if (!quote.target || !Number.isFinite(quote.line)) continue;
      if (!byTarget.has(quote.target)) byTarget.set(quote.target, []);
      byTarget.get(quote.target).push({
        ...quote,
        name: `${quote.target} ${quote.line > 0 ? "+" : ""}${quote.line}`,
      });
    }
    const targets = [...byTarget.keys()];
    if (targets.length !== 2) continue;
    consider(
      [byTarget.get(targets[0]), byTarget.get(targets[1])],
      {
        id: `arb|${sample.event}|${sample.market}|${Math.abs(sample.line)}`,
        event: sample.event,
        category: sample.market,
        market: sample.market,
        line: Math.abs(sample.line),
      },
      { requireOppositeSpread: true },
    );
  }

  odds.sort((a, b) => b.ev - a.ev);
  arbs.sort((a, b) => b.profit - a.profit);
  return dropAlternateSpreads(odds, arbs);
}

async function sendValueAlerts(rows, { sendTelegram, mode = "" } = {}) {
  if (!sendTelegram) return { sentEv: 0, sentArb: 0 };
  const minEv = Number(process.env.TELEGRAM_MIN_EV) || 0.03;
  const minArb = Number(process.env.TELEGRAM_MIN_ARB) || 0.01;
  const maxAlertOdds = Number(process.env.TELEGRAM_MAX_ODDS) || 200;
  const { odds, arbs } = findValueFromOddsRows(rows);
  let sentEv = 0;
  let sentArb = 0;
  const modeTag = mode ? ` [${mode}]` : "";
  // Alerts: player props only, and no price longer than +maxAlertOdds.
  const isPropMarket = (name) => PROP_ALERT_MARKETS.has(String(name || ""));
  const withinOddsCap = (price) => {
    const american = parseAmerican(price);
    return american !== null && american <= maxAlertOdds;
  };

  for (const arb of arbs) {
    if (!isPropMarket(arb.category) && !isPropMarket(arb.market)) continue;
    if (!(arb.profit >= minArb)) continue;
    if (!(arb.legs || []).every((leg) => withinOddsCap(leg.price))) continue;
    const legs = (arb.legs || [])
      .map(
        (leg) =>
          `${leg.target || leg.name}${
            leg.line != null ? ` ${leg.line}` : ""
          } ${leg.price} @ ${leg.sportsbook?.name || leg.sportsbook?.id || "?"}`,
      )
      .join("\n");
    const result = await sendTelegram(
      `ARB +${(arb.profit * 100).toFixed(1)}%${modeTag}\n${arb.event}\n${arb.category || ""}\n${legs}`,
      { key: `arb:${arb.id}` },
    );
    if (result?.ok) sentArb += 1;
  }

  for (const odd of odds) {
    if (!isPropMarket(odd.category) && !isPropMarket(odd.market)) continue;
    if (!withinOddsCap(odd.price)) continue;
    if (!(odd.ev >= minEv)) continue;
    const line =
      odd.line != null
        ? `${odd.side || ""} ${odd.line}`.trim()
        : odd.side || "ML";
    const result = await sendTelegram(
      `+EV ${(odd.ev * 100).toFixed(1)}%${modeTag}\n${odd.event}\n${odd.category} · ${odd.name} · ${line}\n${odd.price} @ ${odd.sportsbook?.name || "?"}\nFair ${odd.fairPrice || "—"} (${(
        (odd.fairProbability || 0) * 100
      ).toFixed(1)}%)`,
      { key: `ev:${odd.id}` },
    );
    if (result?.ok) sentEv += 1;
  }

  return { sentEv, sentArb, oddsCount: odds.length, arbCount: arbs.length };
}

module.exports = {
  findValueFromOddsRows,
  sendValueAlerts,
  MAX_AMERICAN_ODDS,
};
