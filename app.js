/*
 * app.js — reads the CSV files in data/ and draws the page.
 * All the finance math lives in capstruct.js (window.CapStruct).
 */
(function () {
  'use strict';
  const C = window.CapStruct;

  // ---------- Small helpers for building the page ----------

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(k => {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(ch => node.append(ch instanceof Node ? ch : document.createTextNode(String(ch))));
    return node;
  }

  // headers: array of header HTML strings; rows: array of {cells: [...], class?}
  // "stack" tables turn each row into a card on a phone (labels come from data-label).
  function table(headers, rows, opts) {
    opts = opts || {};
    const thead = el('thead', null, [el('tr', null, headers.map(h => el('th', { scope: 'col', html: h })))]);
    const tbody = el('tbody', null, rows.map(r => el('tr', rowAttrs(r),
      r.cells.map((cell, i) => {
        const tag = i === 0 && opts.rowHeaders ? 'th' : 'td';
        const attrs = { 'data-label': headers[i].replace(/<[^>]+>/g, '') };
        if (tag === 'th') attrs.scope = 'row';
        return el(tag, attrs, [cell]);
      }))));
    const t = el('table', { class: opts.stack ? 'stack' : '' }, [thead, tbody]);
    if (opts.caption) t.prepend(el('caption', null, [opts.caption]));
    return el('div', { class: 'table-wrap' }, [t]);
  }

  function rowAttrs(r) {
    const a = {};
    if (r.class) a.class = r.class;
    if (r.debt !== undefined) a['data-debt'] = String(r.debt);
    return a;
  }

  async function loadCSV(path) {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) throw new Error('Could not read ' + path + ' (' + res.status + ')');
    return C.parseCSV(await res.text());
  }

  function showWarnings(list) {
    const box = document.getElementById('warnings');
    box.innerHTML = '';
    list.forEach(w => box.append(el('div', { class: 'note warn', role: 'alert' }, ['⚠ ' + w])));
  }

  // ---------- Firm U and Firm L ----------

  function yearLabels(years) {
    if (years.length === 3) {
      const order = years.map((y, i) => i).sort((a, b) => years[a].ebit - years[b].ebit);
      const names = [];
      names[order[0]] = 'Bad year';
      names[order[1]] = 'Normal year';
      names[order[2]] = 'Good year';
      return names;
    }
    return years.map((y, i) => 'Year type ' + (i + 1));
  }

  function firmTable(name, f) {
    const labels = yearLabels(f.years);
    const each = fn => f.years.map(fn);
    const rows = [
      ['Assets', ...each(() => C.money(f.assets))],
      ['Equity', ...each(() => C.money(f.equity))],
      ['Probability', ...each(y => C.decimal2(y.probability))],
      ['Sales', ...each(y => C.money(y.sales))],
      ['Oper. costs', ...each(y => C.deduction(y.operatingCosts))],
      ['EBIT', ...each(y => C.money(y.ebit))],
      ['Interest', ...each(y => C.deduction(y.interest))],
      ['EBT', ...each(y => C.money(y.ebt))],
      ['Taxes (' + C.pct(f.tax).replace('.00', '') + ')', ...each(y => C.deduction(y.taxes))],
      ['Net income', ...each(y => C.money(y.netIncome))],
      ['ROE', ...each(y => C.pct(y.roe))],
      ['TIE', ...each(y => C.times(y.tie))]
    ].map(cells => ({ cells }));
    const caption = name + (f.debt > 0
      ? ': ' + C.money(f.debt) + ' of debt at ' + C.pct(f.rate)
      : ': no debt');
    return table(['', ...labels], rows, { rowHeaders: true, caption });
  }

  function firmStats(u, l) {
    const rows = [
      ['E(ROE)', C.pct(u.eRoe), C.pct(l.eRoe)],
      ['σ(ROE)', C.pct(u.sdRoe), C.pct(l.sdRoe)],
      ['CV of ROE', C.decimal2(u.cvRoe), C.decimal2(l.cvRoe)],
      ['E(TIE)', C.times(u.eTie), C.times(l.eTie)],
      ['σ(TIE)', C.times(u.sdTie), C.times(l.sdTie)]
    ].map(cells => ({ cells }));
    return table(['', 'Firm U', 'Firm L'], rows, { rowHeaders: true });
  }

  // ---------- CDSS ----------

  function cdssInputs(c, a) {
    const items = [
      ['Sales', C.money(c.sales)],
      ['Variable costs (' + C.pct(c.variable_cost_rate) + ' of sales)', C.deduction(c.sales * c.variable_cost_rate)],
      ['Fixed costs', C.deduction(c.fixed_costs)],
      ['EBIT (the same at every amount of debt)', C.money(a.ebit)],
      ['Shares outstanding today, n', C.decimal2(a.n).replace(/\.00$/, '')],
      ['Today’s share price, P₀', C.cents(a.P0)],
      ['Total book assets, A', C.money(a.A)],
      ['Tax rate, T', C.pct(a.T)],
      ['Management’s share of the stock', C.pct(c.management_share)]
    ];
    return el('dl', { class: 'inputs' }, items.flatMap(([k, v]) => [el('dt', null, [k]), el('dd', null, [v])]));
  }

  function caseTable(a) {
    const best = a.summary.casePrice;
    const headers = ['Debt', 'r<sub>d</sub>', 'r<sub>s</sub>', 'Net income', 'Shares repurchased',
      'Shares remaining', 'EPS', 'TIE', 'Share price', 'WACC (book weights)'];
    const rows = a.rows.map(r => ({
      class: r.debt === best ? 'best' : '', debt: r.debt,
      cells: [C.money(r.debt), C.pct(r.costOfDebt), C.pct(r.costOfEquity), C.money(r.netIncome),
        C.decimal2(r.caseMethod.repurchased), C.decimal2(r.caseMethod.remaining),
        C.cents(r.caseMethod.eps), C.times(r.tie), C.cents(r.caseMethod.price), C.pct(r.caseMethod.wacc)]
    }));
    return table(headers, rows, { stack: true });
  }

  function newPriceTable(a) {
    const best = a.summary.newPrice;
    const headers = ['Debt', 'r<sub>d</sub>', 'r<sub>s</sub>', 'Value of equity S', 'Value of firm V',
      'Share price P', 'Shares repurchased', 'Shares remaining', 'EPS', 'TIE', 'WACC (market weights)'];
    const rows = a.rows.map(r => ({
      class: r.debt === best ? 'best' : '', debt: r.debt,
      cells: [C.money(r.debt), C.pct(r.costOfDebt), C.pct(r.costOfEquity),
        C.money(r.newPrice.equityValue), C.money(r.newPrice.firmValue), C.cents(r.newPrice.price),
        C.decimal2(r.newPrice.repurchased), C.decimal2(r.newPrice.remaining),
        C.cents(r.newPrice.eps), C.times(r.tie), C.pct(r.newPrice.wacc)]
    }));
    return table(headers, rows, { stack: true });
  }

  function summaryBox(a) {
    const s = a.summary;
    const row = d => a.rows.find(r => r.debt === d);
    const line = (label, d, value) => el('li', null, [label + ': ', el('strong', null, [d === null ? C.NA : C.money(d)]),
      d === null ? '' : ' (' + value(row(d)) + ')']);
    const list = el('ul', { class: 'summary' }, [
      line('Highest share price, case method', s.casePrice, r => C.cents(r.caseMethod.price)),
      line('Highest share price, new-price method', s.newPrice, r => C.cents(r.newPrice.price)),
      line('Lowest WACC, book weights', s.bookWacc, r => C.pct(r.caseMethod.wacc)),
      line('Lowest WACC, market weights', s.marketWacc, r => C.pct(r.newPrice.wacc)),
      line('Highest EPS, case method', s.caseEps, r => C.cents(r.caseMethod.eps)),
      line('Highest EPS, new-price method', s.newEps, r => C.cents(r.newPrice.eps))
    ]);
    const note = s.allAgree
      ? el('p', { class: 'hint' }, ['Both prices and both WACCs point to the same amount of debt. The highlighted rows above have the highest price.'])
      : el('p', { class: 'note warn' }, ['The two methods or the two sets of weights don’t all point to the same amount of debt, so the app doesn’t pick one. Compare the rows above.']);
    return el('div', null, [list, note]);
  }

  // ---------- Levers ----------

  function stakeCell(m) {
    if (m.status === 'ok') return C.pct(m.value);
    if (m.status === 'all') return C.pct(1) + ' *';
    if (m.status === 'sell') return 'Would have to sell';
    return C.NA;
  }

  // The two buyback methods side by side at one amount of debt.
  function cdssReadout(a, r) {
    const A = r.caseMethod, B = r.newPrice;
    const head = ['At ' + C.money(r.debt), 'A. Buy back at ' + C.cents(a.P0), 'B. Buy back at the new price'];
    const rows = [
      ['Share price', C.cents(A.price), C.cents(B.price)],
      ['Shares repurchased', C.decimal2(A.repurchased), C.decimal2(B.repurchased)],
      ['Shares remaining', C.decimal2(A.remaining), C.decimal2(B.remaining)],
      ['EPS', C.cents(A.eps), C.cents(B.eps)],
      ['Dividends per share', C.cents(A.dps), C.cents(B.dps)],
      ['TIE', C.times(r.tie), C.times(r.tie)],
      ['WACC (A: book weights, B: market weights)', C.pct(A.wacc), C.pct(B.wacc)],
      ['Management’s share of the company', stakeCell(A.management), stakeCell(B.management)]
    ].map(cells => ({ cells }));
    const facts = el('p', { class: 'hint' }, [
      'r_d ' + C.pct(r.costOfDebt) + ' · r_s ' + C.pct(r.costOfEquity) +
      ' · interest ' + C.money(r.interest) + ' · net income ' + C.money(r.netIncome) +
      ' · dividends per share = EPS, because CDSS pays out all its earnings'
    ]);
    const notes = [];
    [['A', A.management], ['B', B.management]].forEach(([col, m]) => {
      if (m.status === 'all') notes.push(el('p', { class: 'note' }, ['* Column ' + col + ': the buyback takes every outside share, so management would own 100% and no outside shareholders would be left.']));
      if (m.status === 'sell') notes.push(el('p', { class: 'note warn' }, ['⚠ Column ' + col + ': the buyback needs more shares than outside investors own, so management would have to sell some of its own.']));
    });
    return el('div', null, [facts, table(head, rows, { rowHeaders: true, caption: 'Both buyback methods at ' + C.money(r.debt) + ' of debt' }), ...notes]);
  }

  function setupCdssSlider(a) {
    const slider = document.getElementById('cdss-debt');
    const out = document.getElementById('cdss-debt-out');
    const readout = document.getElementById('cdss-readout');
    const noteBox = document.getElementById('cdss-button-note');
    const ticks = document.getElementById('cdss-ticks');
    slider.max = String(a.rows.length - 1);
    ticks.innerHTML = '';
    a.rows.forEach(r => ticks.append(el('span', null, [C.money(r.debt / 1000) + 'k'])));

    function show(i) {
      const r = a.rows[i];
      slider.value = String(i);
      out.textContent = C.money(r.debt);
      slider.setAttribute('aria-valuetext', C.money(r.debt));
      readout.innerHTML = '';
      readout.append(cdssReadout(a, r));
      document.querySelectorAll('#cdss tr[data-debt]').forEach(tr =>
        tr.classList.toggle('current', Number(tr.dataset.debt) === r.debt));
    }
    function goTo(choice) {
      noteBox.innerHTML = '';
      if (choice.debt === null) return;
      if (choice.note) noteBox.append(el('p', { class: 'note' }, [choice.note]));
      show(a.rows.findIndex(r => r.debt === choice.debt));
    }

    slider.oninput = () => { noteBox.innerHTML = ''; show(Number(slider.value)); };
    document.getElementById('btn-best').onclick = () =>
      goTo(C.chooseDebt(a.summary.casePrice, a.summary.newPrice, 'highest share price'));
    document.getElementById('btn-eps').onclick = () =>
      goTo(C.chooseDebt(a.summary.caseEps, a.summary.newEps, 'highest EPS'));

    const start = a.rows.findIndex(r => r.debt === 0);
    show(start >= 0 ? start : 0);
  }

  function setupFirmSlider(scenarios, firms, tax, u) {
    const slider = document.getElementById('firm-l-debt');
    const out = document.getElementById('firm-l-debt-out');
    const steps = C.sliderSteps(firms.slider_max, firms.slider_step);
    slider.min = '0';
    slider.max = String(steps[steps.length - 1]);
    slider.step = String(firms.slider_step);
    document.getElementById('firm-l-rate-note').textContent =
      'The interest rate is held at ' + C.pct(firms.interest_rate) + ' at every amount of debt, the case’s rate. ' +
      'So the slider shows what debt does to Firm L’s return and risk, not how lenders would respond to more borrowing.';

    function show(debt) {
      slider.value = String(debt);
      out.textContent = C.money(debt);
      slider.setAttribute('aria-valuetext', C.money(debt));
      const l = C.firmExample(scenarios, { assets: firms.total_assets, debt, rate: firms.interest_rate, tax });
      const box = document.getElementById('firm-l');
      box.innerHTML = '';
      box.append(firmTable('Firm L', l));
      const stats = document.getElementById('firm-stats');
      stats.innerHTML = '';
      stats.append(firmStats(u, l));
    }
    slider.oninput = () => show(Number(slider.value));
    document.getElementById('btn-case').onclick = () => show(firms.firm_l_debt);
    show(firms.firm_l_debt);
  }

  // ---------- Load everything and draw ----------

  async function main() {
    const status = document.getElementById('status');
    try {
      const [cdssRows, assumptionRows, scheduleRows, firmRows, scenarioRows] = await Promise.all([
        loadCSV('data/cdss.csv'),
        loadCSV('data/assumptions.csv'),
        loadCSV('data/banker_schedule.csv'),
        loadCSV('data/example_firms.csv'),
        loadCSV('data/ebit_scenarios.csv')
      ]);

      const cdss = C.itemsToObject(cdssRows, 'item', 'value');
      const tax = C.itemsToObject(assumptionRows, 'assumption', 'value').tax_rate;
      const firms = C.itemsToObject(firmRows, 'item', 'value');
      const schedule = scheduleRows.map(r => ({
        debt: C.toNumber(r.debt, 'debt'),
        cost_of_debt: C.toNumber(r.cost_of_debt, 'cost_of_debt'),
        cost_of_equity: C.toNumber(r.cost_of_equity, 'cost_of_equity')
      }));
      const scenarios = scenarioRows.map(r => ({
        probability: C.toNumber(r.probability, 'probability'),
        sales: C.toNumber(r.sales, 'sales'),
        operating_costs: C.toNumber(r.operating_costs, 'operating_costs')
      }));

      const warnings = [];

      // Firm U and Firm L
      const u = C.firmExample(scenarios, { assets: firms.total_assets, debt: 0, rate: firms.interest_rate, tax });
      if (Math.abs(u.probabilitySum - 1) > 1e-9) warnings.push('The probabilities in ebit_scenarios.csv add up to ' + u.probabilitySum + ', not 1.');
      document.getElementById('firm-u').append(firmTable('Firm U', u));
      setupFirmSlider(scenarios, firms, tax, u);
      document.getElementById('firms').hidden = false;

      // CDSS
      const a = C.cdssAnalysis(cdss, schedule, tax);
      warnings.push(...a.warnings);
      document.getElementById('p0-text').textContent = C.cents(a.P0);
      document.getElementById('cdss-inputs').append(cdssInputs(cdss, a));
      document.getElementById('case-table').append(caseTable(a));
      document.getElementById('newprice-table').append(newPriceTable(a));
      document.getElementById('summary').append(summaryBox(a));
      setupCdssSlider(a);
      document.getElementById('cdss').hidden = false;

      showWarnings(warnings);
      status.hidden = true;
    } catch (err) {
      status.className = 'note warn';
      status.textContent = 'The app could not load its data: ' + err.message +
        '. It needs to be opened from a web address (such as GitHub Pages), not as a file on your computer.';
    }
  }

  main();
})();
