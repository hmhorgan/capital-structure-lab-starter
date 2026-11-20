/*
 * capstruct.js — the finance math for the AGE capital structure app.
 *
 * Every function here is "pure": it takes numbers in and gives numbers back,
 * and never touches the web page. That lets us check the math with Node, e.g.
 *   node -e "const C=require('./capstruct.js'); console.log(C.roundHalfUp(0.14025*100,2))"
 *
 * Notation (same as CLAUDE.md): T = tax rate, D = amount borrowed,
 * n = shares outstanding before any buyback, P0 = today's price, A = total book assets.
 */
(function (root) {
  'use strict';

  // ---------- Reading CSV files ----------

  // Split one CSV line into cells, allowing "quoted, cells".
  function splitCSVLine(line) {
    const cells = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQuotes = false;
        else cur += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    return cells.map(c => c.trim());
  }

  // Turn CSV text into an array of objects keyed by the header row.
  function parseCSV(text) {
    const lines = String(text).replace(/^﻿/, '').replace(/\r/g, '')
      .split('\n').filter(l => l.trim() !== '');
    if (lines.length === 0) return [];
    const headers = splitCSVLine(lines[0]);
    return lines.slice(1).map(line => {
      const cells = splitCSVLine(line);
      const row = {};
      headers.forEach((h, i) => { row[h] = cells[i] === undefined ? '' : cells[i]; });
      return row;
    });
  }

  // A blank cell becomes null (for example, the $0 row has no cost of debt).
  function toNumber(s, label) {
    if (s === null || s === undefined || String(s).trim() === '') return null;
    const x = Number(s);
    if (!Number.isFinite(x)) throw new Error('Not a number: "' + s + '"' + (label ? ' (' + label + ')' : ''));
    return x;
  }

  // Turn item,value rows (cdss.csv, assumptions.csv, example_firms.csv) into {item: number}.
  function itemsToObject(rows, keyCol, valueCol) {
    const out = {};
    rows.forEach(r => { out[r[keyCol]] = toNumber(r[valueCol], r[keyCol]); });
    return out;
  }

  // ---------- Rounding and display ----------

  // Round half up on the DECIMAL value. toFixed rounds the binary value instead,
  // so 14.025 would show as 14.02; this shows 14.03.
  function roundHalfUp(x, d) {
    const f = Math.pow(10, d);
    return Math.round(Number((x * f).toPrecision(12))) / f;
  }

  function withCommas(x, d) {
    const r = roundHalfUp(Math.abs(x), d);
    const s = r.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    return (x < 0 && r !== 0 ? '−' : '') + s;
  }

  const NA = 'n/a';
  const isNum = x => typeof x === 'number' && Number.isFinite(x);

  function money(x)   { if (!isNum(x)) return NA; return (x < 0 && roundHalfUp(-x, 0) !== 0 ? '−' : '') + '$' + withCommas(Math.abs(x), 0); }
  function cents(x)   { if (!isNum(x)) return NA; return (x < 0 && roundHalfUp(-x, 2) !== 0 ? '−' : '') + '$' + withCommas(Math.abs(x), 2); }
  function pct(x)     { return isNum(x) ? withCommas(x * 100, 2) + '%' : NA; }
  function times(x)   { return isNum(x) ? withCommas(x, 2) + '×' : NA; }
  function decimal2(x){ return isNum(x) ? withCommas(x, 2) : NA; }
  // A deduction shown like the case's table: (4,000)
  function deduction(x) { return isNum(x) ? '(' + withCommas(x, 0) + ')' : NA; }

  // ---------- Statistics ----------

  // Probability-weighted average.
  function expected(probs, values) {
    return probs.reduce((sum, p, i) => sum + p * values[i], 0);
  }
  // Square root of the probability-weighted squared deviations.
  function stdDev(probs, values) {
    const mean = expected(probs, values);
    return Math.sqrt(probs.reduce((sum, p, i) => sum + p * Math.pow(values[i] - mean, 2), 0));
  }

  // ---------- Firm U and Firm L (question c) ----------

  // scenarios: [{probability, sales, operating_costs}] from ebit_scenarios.csv
  // Returns the partial income statement for each kind of year plus the ratios.
  function firmExample(scenarios, opts) {
    const assets = opts.assets, debt = opts.debt, rate = opts.rate, tax = opts.tax;
    const equity = assets - debt;
    const years = scenarios.map(s => {
      const ebit = s.sales - s.operating_costs;
      const interest = rate * debt;
      const ebt = ebit - interest;
      const taxes = tax * ebt;
      const netIncome = ebt - taxes;
      return {
        probability: s.probability,
        sales: s.sales,
        operatingCosts: s.operating_costs,
        ebit, interest, ebt, taxes, netIncome,
        roe: netIncome / equity,
        tie: interest > 0 ? ebit / interest : null // no interest: TIE is n/a, not infinity
      };
    });
    const probs = years.map(y => y.probability);
    const roes = years.map(y => y.roe);
    const eRoe = expected(probs, roes);
    const sdRoe = stdDev(probs, roes);
    const hasTie = years.every(y => y.tie !== null);
    const ties = hasTie ? years.map(y => y.tie) : null;
    const eTie = hasTie ? expected(probs, ties) : null;
    const sdTie = hasTie ? stdDev(probs, ties) : null;
    return {
      assets, debt, equity, rate, tax, years,
      eRoe, sdRoe, cvRoe: eRoe !== 0 ? sdRoe / eRoe : null,
      eTie, sdTie, cvTie: hasTie && eTie !== 0 ? sdTie / eTie : null,
      probabilitySum: probs.reduce((a, b) => a + b, 0)
    };
  }

  // ---------- CDSS ----------

  // EBIT = sales x (1 - variable cost rate) - fixed costs
  function cdssEbit(c) {
    return c.sales * (1 - c.variable_cost_rate) - c.fixed_costs;
  }

  // c: cdss.csv as {item: value}; schedule: [{debt, cost_of_debt, cost_of_equity}]; tax: T
  function cdssAnalysis(c, schedule, tax) {
    const T = tax;
    const n = c.shares_outstanding;
    const P0 = c.share_price;
    const A = c.total_assets;
    const ebit = cdssEbit(c);
    const warnings = [];

    const sorted = schedule.slice().sort((a, b) => a.debt - b.debt);

    const rows = sorted.map(r => {
      const D = r.debt;
      const rd = r.cost_of_debt;   // null at $0
      const rs = r.cost_of_equity;
      if (D > 0 && rd === null) warnings.push('The schedule has no cost of debt at ' + money(D) + '.');
      const interest = D > 0 ? rd * D : 0;
      const netIncome = (ebit - interest) * (1 - T);
      const tie = interest > 0 ? ebit / interest : null;
      const debtCostAfterTax = D > 0 ? rd * (1 - T) : 0;

      // Case method (d(3) and d(4)): buy back at today's P0.
      const caseRepurchased = D / P0;
      const caseRemaining = n - caseRepurchased;
      const caseOk = caseRemaining > 0;
      const caseEps = caseOk ? netIncome / caseRemaining : null;
      const casePrice = caseOk ? caseEps / rs : null;
      const bookWacc = (D / A) * debtCostAfterTax + ((A - D) / A) * rs;

      // New-price method: buy back at the price after the announcement.
      const S = netIncome / rs;          // value of equity
      const V = S + D;                   // value of the firm
      const P = V / n;                   // price per share
      const npRepurchased = D / P;
      const npRemaining = n - npRepurchased;
      const npEps = netIncome / npRemaining;
      const marketWacc = (D / V) * debtCostAfterTax + (S / V) * rs;

      // Checks: EPS = r_s x P, and market WACC = EBIT(1 - T) / V
      const epsCheck = Math.abs(npEps - rs * P) < 1e-9 * Math.max(1, Math.abs(npEps));
      const waccCheck = Math.abs(marketWacc - ebit * (1 - T) / V) < 1e-12;
      if (!epsCheck) warnings.push('Check failed at ' + money(D) + ': new-price EPS does not equal r_s × P.');
      if (!waccCheck) warnings.push('Check failed at ' + money(D) + ': market-weight WACC does not equal EBIT(1 − T) / V.');
      if (!caseOk) warnings.push('At ' + money(D) + ' the $' + P0 + ' buyback would retire every share, so the case method has no EPS or price.');

      return {
        debt: D, costOfDebt: rd, costOfEquity: rs,
        interest, netIncome, tie,
        caseMethod: {
          repurchased: caseRepurchased, remaining: caseRemaining,
          eps: caseEps, dps: caseEps, price: casePrice, wacc: bookWacc
        },
        newPrice: {
          equityValue: S, firmValue: V, price: P,
          repurchased: npRepurchased, remaining: npRemaining,
          eps: npEps, dps: npEps, wacc: marketWacc,
          epsCheck, waccCheck
        }
      };
    });

    // At $0 of debt, EPS / r_s should equal today's price in cdss.csv.
    const zero = rows.find(r => r.debt === 0);
    let zeroCheck = null;
    if (zero) {
      zeroCheck = roundHalfUp(zero.caseMethod.price, 2) === roundHalfUp(P0, 2);
      if (!zeroCheck) {
        warnings.push('With no debt, EPS / r_s = ' + cents(zero.caseMethod.price) +
          ', but today’s price in cdss.csv is ' + cents(P0) +
          '. The schedule’s cost of equity at $0 does not match the market price.');
      }
    } else {
      warnings.push('The schedule has no $0 row, so the app cannot check it against today’s price.');
    }

    return { ebit, n, P0, A, T, rows, warnings, zeroCheck, summary: summarize(rows) };
  }

  // Index of the best row. Rows are sorted by debt and we only replace on a
  // strictly better value, so an exact tie keeps the smaller amount of debt.
  function bestIndex(rows, get, better) {
    let best = -1;
    rows.forEach((r, i) => {
      const v = get(r);
      if (!isNum(v)) return;
      if (best === -1 || better(v, get(rows[best]))) best = i;
    });
    return best;
  }

  function summarize(rows) {
    const hi = (a, b) => a > b, lo = (a, b) => a < b;
    const pick = i => (i >= 0 ? rows[i].debt : null);
    const s = {
      casePrice:  pick(bestIndex(rows, r => r.caseMethod.price, hi)),
      newPrice:   pick(bestIndex(rows, r => r.newPrice.price, hi)),
      bookWacc:   pick(bestIndex(rows, r => r.caseMethod.wacc, lo)),
      marketWacc: pick(bestIndex(rows, r => r.newPrice.wacc, lo)),
      caseEps:    pick(bestIndex(rows, r => r.caseMethod.eps, hi)),
      newEps:     pick(bestIndex(rows, r => r.newPrice.eps, hi))
    };
    const four = [s.casePrice, s.newPrice, s.bookWacc, s.marketWacc];
    s.allAgree = four.every(x => x === four[0]);
    return s;
  }

  const CapStruct = {
    parseCSV, toNumber, itemsToObject,
    roundHalfUp, money, cents, pct, times, decimal2, deduction, NA,
    expected, stdDev,
    firmExample, cdssEbit, cdssAnalysis, summarize
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = CapStruct;
  else root.CapStruct = CapStruct;
})(typeof window !== 'undefined' ? window : this);
