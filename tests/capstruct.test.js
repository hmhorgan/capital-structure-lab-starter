/*
 * Tests for capstruct.js, using the real CSV files in data/.
 * Run from the top of the repository:   node tests/capstruct.test.js
 * Uses only Node's built-in assert module (no npm packages).
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('../capstruct.js');

const read = f => C.parseCSV(fs.readFileSync(path.join(__dirname, '..', 'data', f), 'utf8'));
const schedule = f => read(f).map(r => ({
  debt: C.toNumber(r.debt), cost_of_debt: C.toNumber(r.cost_of_debt), cost_of_equity: C.toNumber(r.cost_of_equity)
}));

const cdss = C.itemsToObject(read('cdss.csv'), 'item', 'value');
const tax = C.itemsToObject(read('assumptions.csv'), 'assumption', 'value').tax_rate;
const firms = C.itemsToObject(read('example_firms.csv'), 'item', 'value');
const scenarios = read('ebit_scenarios.csv').map(r => ({
  probability: C.toNumber(r.probability), sales: C.toNumber(r.sales), operating_costs: C.toNumber(r.operating_costs)
}));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { console.log('FAIL ' + name + '\n     ' + e.message); process.exitCode = 1; }
}

const a = C.cdssAnalysis(cdss, schedule('banker_schedule.csv'), tax);
const at = d => a.rows.find(r => r.debt === d);

// ---------- Rounding ----------
test('round half up on the decimal value (14.025% -> 14.03%, $3.495 -> $3.50)', () => {
  assert.strictEqual(C.pct(0.14025), '14.03%');
  assert.strictEqual(C.cents(3.495), '$3.50');
  assert.strictEqual(C.times(500000 / 160000), '3.13×');
});

// ---------- CDSS ----------
test('EBIT is $500,000', () => assert.strictEqual(a.ebit, 500000));

test('$20-buyback prices: $20.00, $21.01, $21.58, $21.47, $20.40', () => {
  assert.deepStrictEqual(a.rows.map(r => C.cents(r.caseMethod.price)),
    ['$20.00', '$21.01', '$21.58', '$21.47', '$20.40']);
});

test('$20-buyback EPS, shares remaining and TIE', () => {
  assert.deepStrictEqual(a.rows.map(r => C.cents(r.caseMethod.eps)), ['$3.00', '$3.26', '$3.56', '$3.86', '$4.08']);
  assert.deepStrictEqual(a.rows.map(r => C.decimal2(r.caseMethod.remaining)),
    ['100,000.00', '87,500.00', '75,000.00', '62,500.00', '50,000.00']);
  assert.deepStrictEqual(a.rows.map(r => C.times(r.tie)), ['n/a', '20.00×', '9.09×', '5.13×', '3.13×']);
});

test('dividends per share equal EPS (all earnings paid out)', () => {
  a.rows.forEach(r => {
    assert.strictEqual(r.caseMethod.dps, r.caseMethod.eps);
    assert.strictEqual(r.newPrice.dps, r.newPrice.eps);
  });
});

test('book-weight WACC at $500,000 is 14.03%', () => assert.strictEqual(C.pct(at(500000).caseMethod.wacc), '14.03%'));

test('new-price method: P at $500,000 is $21.18, EPS $3.50, checks pass', () => {
  const r = at(500000);
  assert.strictEqual(C.cents(r.newPrice.price), '$21.18');
  assert.strictEqual(C.cents(r.newPrice.eps), '$3.50');
  a.rows.forEach(x => { assert.ok(x.newPrice.epsCheck); assert.ok(x.newPrice.waccCheck); });
});

test('price at $0 equals today’s $20 and there are no warnings', () => {
  assert.strictEqual(a.zeroCheck, true);
  assert.deepStrictEqual(a.warnings, []);
});

test('management’s stake: 66.67% at $500,000; 100% (no outsiders left) at $1,000,000 with the $20 buyback', () => {
  assert.strictEqual(C.pct(at(500000).caseMethod.management.value), '66.67%');
  assert.strictEqual(at(1000000).caseMethod.management.status, 'all');
  assert.strictEqual(at(1000000).newPrice.management.status, 'ok');
});

test('"Best price" lands on $500,000 with no note', () => {
  assert.deepStrictEqual(C.chooseDebt(a.summary.casePrice, a.summary.newPrice, 'highest share price'), { debt: 500000, note: null });
});

test('"Highest EPS" lands on $1,000,000', () => {
  assert.strictEqual(C.chooseDebt(a.summary.caseEps, a.summary.newEps, 'highest EPS').debt, 1000000);
});

test('when the two methods disagree, go to the case method’s amount and name both', () => {
  const c = C.chooseDebt(500000, 250000, 'highest share price');
  assert.strictEqual(c.debt, 500000);
  assert.ok(c.note.includes('$500,000') && c.note.includes('$250,000'));
});

test('exact tie picks the smaller amount of debt', () => {
  const rows = [{ debt: 0, caseMethod: { price: 21 }, newPrice: {} }, { debt: 1, caseMethod: { price: 21 }, newPrice: {} }];
  assert.strictEqual(C.summarize(rows).casePrice, 0);
});

// ---------- Firm U and Firm L ----------
const firmAt = debt => C.firmExample(scenarios, { assets: firms.total_assets, debt, rate: firms.interest_rate, tax });

test('Firm L slider steps are $0 to $12,500 by $2,500', () => {
  assert.deepStrictEqual(C.sliderSteps(firms.slider_max, firms.slider_step), [0, 2500, 5000, 7500, 10000, 12500]);
});

test('Firm L at $10,000: E(TIE) = 2.50, σ(TIE) = 0.59', () => {
  const l = firmAt(10000);
  assert.strictEqual(C.times(l.eTie), '2.50×');
  assert.strictEqual(C.times(l.sdTie), '0.59×');
});

test('Firm L at $10,000: ROE 4.80/10.80/16.80%, E(ROE) 10.80%, σ(ROE) 4.24%, CV 0.39', () => {
  const l = firmAt(10000);
  assert.deepStrictEqual(l.years.map(y => C.pct(y.roe)), ['4.80%', '10.80%', '16.80%']);
  assert.strictEqual(C.pct(l.eRoe), '10.80%');
  assert.strictEqual(C.pct(l.sdRoe), '4.24%');
  assert.strictEqual(C.decimal2(l.cvRoe), '0.39');
});

test('Firm U: E(ROE) 9.00%, σ(ROE) 2.12%, TIE n/a', () => {
  const u = firmAt(0);
  assert.strictEqual(C.pct(u.eRoe), '9.00%');
  assert.strictEqual(C.pct(u.sdRoe), '2.12%');
  assert.strictEqual(C.times(u.eTie), 'n/a');
  assert.strictEqual(C.times(u.sdTie), 'n/a');
});

console.log('\n' + passed + ' tests passed' + (process.exitCode ? ', some FAILED' : ''));
