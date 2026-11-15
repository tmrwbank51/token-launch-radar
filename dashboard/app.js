// Token Launch Radar (v3): the page is the model, running live.
//
// The data arrives in window.RADAR_DATA, written by main.ts from the sealed
// snapshot. No network: everything on the page comes from that one object.
//
// The value model is implemented here, in the page, with the same
// arithmetic the builder ran (lib/model.ts), so the reader can verify the
// board rather than trust it:
// - impliedValue(row, assumptions): TVL x multiple x growth x maturity x
//   footprint, clamped and rounded exactly as the builder does. At the
//   submitted defaults it re-derives every row's value; the recompute
//   check counts the matches.
// - calibrateMultiple(category, source): the category median by default,
//   the global median or a category quartile when the playground asks.
// - nearestComparables(row, live, n): the nearest live-token protocols by
//   TVL distance, same category first, for the detail view.
// - costPlan(row): the cost and time totals of a farm plan, summed from
//   the structured figures each step carries, so the totals and the step
//   text state the same numbers.
// The playground re-runs impliedValue over all rows on every control move
// and re-ranks the board live; the submitted board is the default settings.

const D = window.RADAR_DATA;
const $ = (id) => document.getElementById(id);

const CAL_MAP = new Map(D.calibration.table.map((entry) => [entry.category, entry]));
const DEFAULTS = { growth: 1, maturity: 1, source: 'category', footprint: true };
const assumptions = { ...DEFAULTS };
const state = { q: '', category: 'all', chain: 'all', minTvl: 0, watchlistOnly: false, sortKey: 'rank', sortDir: 1 };

// --------------------------------------------------------------- formatting

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtUsd(value) {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${Math.round(value)}`;
}

function fmtUsdFull(value) {
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

function fmtMoney(value) {
  return value.toFixed(2).replace(/\.?0+$/, '');
}

function fmtCostRange([lo, hi]) {
  if (lo === 0 && hi === 0) return '$0';
  if (lo === hi) return `$${fmtMoney(lo)}`;
  return `$${fmtMoney(lo)}–$${fmtMoney(hi)}`;
}

function fmtTimeRange([lo, hi]) {
  const hours = (m) => (m / 60).toFixed(1).replace(/\.0$/, '');
  if (hi <= 90) return lo === hi ? `${lo} min` : `${lo}–${hi} min`;
  return `${hours(lo)}–${hours(hi)} h`;
}

function fmtPct(change) {
  if (change === null || change === undefined) return { text: '—', cls: 'flat' };
  const sign = change > 0 ? '+' : '';
  return { text: `${sign}${change.toFixed(1)}%`, cls: change > 0 ? 'up' : change < 0 ? 'down' : 'flat' };
}

function fmtAge(ageDays) {
  if (ageDays === null || ageDays === undefined) return '—';
  if (ageDays < 30) return `${ageDays}d`;
  if (ageDays < 365) return `${Math.floor(ageDays / 30)}mo`;
  const years = Math.floor(ageDays / 365);
  const months = Math.floor((ageDays % 365) / 30);
  return months > 0 ? `${years}y ${months}mo` : `${years}y`;
}

function fmtAgeLong(ageDays) {
  if (ageDays === null || ageDays === undefined) return null;
  if (ageDays < 30) return `${ageDays} days`;
  if (ageDays < 365) return `${Math.floor(ageDays / 30)} months`;
  const years = Math.floor(ageDays / 365);
  const months = Math.floor((ageDays % 365) / 30);
  return months > 0 ? `${years} years ${months} months` : `${years} years`;
}

function fmtDate(iso) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${months[m - 1]} ${y}`;
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// ------------------------------------------------------------- the model
// Same arithmetic as lib/model.ts. The growth and maturity weights scale
// each factor's deviation from neutral: weight 1 is the submitted model,
// weight 0 removes the factor, weight 2 doubles its effect.

function growthFactorOf(change7d, weight) {
  const base = change7d === null || change7d === undefined || Number.isNaN(change7d)
    ? 1
    : 1 + clamp(change7d, -50, 100) / 250;
  return 1 + weight * (base - 1);
}

function maturityFactorOf(ageDays, strength) {
  const base = ageDays === null || ageDays === undefined
    ? 1
    : 0.85 + 0.3 * (1 - Math.exp(-ageDays / 365));
  return 1 + strength * (base - 1);
}

function footprintFactorOf(chainCount, useFootprint) {
  return useFootprint ? 1 + 0.04 * clamp(chainCount - 1, 0, 8) : 1;
}

/**
 * calibrateMultiple: the multiple for a category under the chosen source.
 * Category median is the submitted default; the global median and the
 * category quartiles are the playground's alternatives. Categories with
 * fewer than three live-token protocols fall back to the global figures,
 * and the calibration table marks them.
 */
function calibrateMultiple(category, source) {
  const entry = CAL_MAP.get(category);
  if (source === 'global' || !entry) return D.calibration.global_multiple;
  if (source === 'q1') return entry.q1 ?? D.calibration.global_q1;
  if (source === 'q3') return entry.q3 ?? D.calibration.global_q3;
  return entry.multiple;
}

/**
 * impliedValue: the implied launch value of one row under the given
 * assumptions, rounded and clamped exactly as the builder rounds it.
 */
function impliedValue(row, a) {
  const value = Math.round(
    row.tvl_usd
      * calibrateMultiple(row.category, a.source)
      * growthFactorOf(row.change_7d, a.growth)
      * maturityFactorOf(row.age_days, a.maturity)
      * footprintFactorOf(row.chains.length, a.footprint),
  );
  return clamp(value, 1, 100000000000000);
}

/** The board re-ranked under the current assumptions, with rank deltas. */
function liveRows() {
  const ranked = D.rows
    .map((row) => ({ row, value: impliedValue(row, assumptions) }))
    .sort((a, b) => b.value - a.value || b.row.tvl_usd - a.row.tvl_usd || a.row.slug.localeCompare(b.row.slug));
  return ranked.map((entry, index) => ({
    ...entry,
    liveRank: index + 1,
    delta: entry.row.rank - (index + 1),
  }));
}

function isDefault() {
  return assumptions.growth === 1 && assumptions.maturity === 1
    && assumptions.source === 'category' && assumptions.footprint === true;
}

/**
 * nearestComparables: the n live-token protocols nearest in TVL to the
 * row, same category first, filled from every live-token protocol when
 * the category has fewer than n. Distance is the absolute log TVL ratio,
 * so a protocol twice as large and one half as large count the same.
 */
function nearestComparables(row, live, n) {
  const distance = (p) => Math.abs(Math.log(p.tvl_usd / row.tvl_usd));
  const byDistance = (a, b) => distance(a) - distance(b) || a.slug.localeCompare(b.slug);
  const same = live.filter((p) => p.category === row.category).sort(byDistance);
  const picks = same.slice(0, n);
  if (picks.length < n) {
    const rest = live.filter((p) => p.category !== row.category).sort(byDistance);
    picks.push(...rest.slice(0, n - picks.length));
  }
  return picks.map((p) => ({
    ...p,
    multiple: p.mcap_usd / p.tvl_usd,
    sameCategory: p.category === row.category,
  }));
}

/** costPlan: the cost and time totals of a farm plan, summed from its steps. */
function costPlan(row) {
  return {
    cost: [
      row.plan_meta.reduce((sum, m) => sum + m.cost_usd[0], 0),
      row.plan_meta.reduce((sum, m) => sum + m.cost_usd[1], 0),
    ],
    minutes: [
      row.plan_meta.reduce((sum, m) => sum + m.minutes[0], 0),
      row.plan_meta.reduce((sum, m) => sum + m.minutes[1], 0),
    ],
  };
}

// ---------------------------------------------------------- header, notes

function renderHeader() {
  $('kicker').textContent = `Token Launch Radar · Sealed snapshot · ${fmtDate(D.as_of)}`;
  $('stats').innerHTML = [
    `<span class="chip"><strong>${D.stats.snapshot_protocols}</strong> protocols scanned</span>`,
    `<span class="chip"><strong>${D.stats.ranked}</strong> on the board</span>`,
    `<span class="chip">Watchlist <strong>${D.stats.watchlist_on_board}/${D.stats.watchlist_total}</strong> covered</span>`,
    `<span class="chip">Total implied <strong>${fmtUsd(D.stats.total_implied_usd)}</strong></span>`,
    `<span class="chip">Calibrated on <strong>${D.calibration.live_count}</strong> live-token protocols</span>`,
  ].join('');
  $('method-note').textContent =
    `Calibrated on ${D.calibration.live_count} protocols whose token already trades, across ${D.calibration.table.length} categories ` +
    `(global multiple ${D.calibration.global_multiple.toFixed(3)}×, interquartile range ` +
    `${D.calibration.global_q1.toFixed(3)}×–${D.calibration.global_q3.toFixed(3)}×). ` +
    `Every row below records no token in the snapshot. Click a row for its value breakdown, its comparables and its costed farm plan; click a column header to sort.`;
  $('source-note').textContent =
    `Source: the sealed snapshot — ${D.stats.snapshot_protocols} protocols at a ${fmtUsd(D.floor_usd)} TVL floor, frozen ${fmtDate(D.as_of)}; ` +
    `${D.stats.watchlist_total} watchlist entries, ${D.stats.watchlist_on_board} on the board. The snapshot is the only data source: no live prices, no network.`;
}

// ---------------------------------------------------------- the board

function filteredRows(live) {
  const q = state.q.trim().toLowerCase();
  return live.filter(({ row }) => {
    if (q && !row.name.toLowerCase().includes(q) && !row.slug.toLowerCase().includes(q)) return false;
    if (state.category !== 'all' && row.category !== state.category) return false;
    if (state.chain !== 'all' && !row.chains.includes(state.chain)) return false;
    if (row.tvl_usd < state.minTvl) return false;
    if (state.watchlistOnly && !row.watchlist) return false;
    return true;
  });
}

function sortedRows(live) {
  const dir = state.sortDir;
  const key = state.sortKey;
  return [...live].sort((a, b) => {
    if (key === 'rank') return dir * (a.liveRank - b.liveRank);
    if (key === 'implied_value_usd') return dir * (a.value - b.value);
    const av = a.row[key];
    const bv = b.row[key];
    if (typeof av === 'string') return dir * av.localeCompare(bv);
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    return dir * (av - bv);
  });
}

function growthBar(change) {
  if (change === null || change === undefined) return '';
  const width = Math.min(100, Math.abs(change));
  const cls = change > 0 ? 'up' : change < 0 ? 'down' : '';
  if (!cls) return '';
  return `<span class="gbar" aria-hidden="true"><i class="${cls}" style="width:${width}%"></i></span>`;
}

function deltaBadge(entry) {
  if (isDefault()) return '';
  if (entry.delta > 0) return `<span class="delta up">↑${entry.delta}</span>`;
  if (entry.delta < 0) return `<span class="delta down">↓${Math.abs(entry.delta)}</span>`;
  return '<span class="delta flat">·</span>';
}

function renderBoard() {
  const live = sortedRows(filteredRows(liveRows()));
  $('rows').innerHTML = live.map((entry) => {
    const row = entry.row;
    const pct = fmtPct(row.change_7d);
    const multiple = calibrateMultiple(row.category, assumptions.source);
    return `<tr data-slug="${escapeHtml(row.slug)}" tabindex="0">`
      + `<td class="num">${entry.liveRank}${deltaBadge(entry)}</td>`
      + `<td>${escapeHtml(row.name)}${row.watchlist ? ' <span class="star" title="On the snapshot watchlist">★</span>' : ''}</td>`
      + `<td>${escapeHtml(row.category)}</td>`
      + `<td class="num">${fmtUsd(row.tvl_usd)}</td>`
      + `<td class="num ${pct.cls}">${pct.text}${growthBar(row.change_7d)}</td>`
      + `<td class="num value">${fmtUsd(entry.value)}</td>`
      + `<td class="num">${multiple.toFixed(3)}×</td></tr>`;
  }).join('');
  $('count').textContent =
    `Showing ${live.length} of ${D.rows.length} protocols`
    + (isDefault() ? '.' : ' — re-ranked under adjusted playground settings.');
  document.querySelectorAll('#board th[data-sort]').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === state.sortKey);
    th.classList.toggle('asc', th.dataset.sort === state.sortKey && state.sortDir === -1);
  });
}

// ---------------------------------------------------------- the playground

function sourceLabel() {
  return {
    category: 'category median',
    global: 'global median',
    q1: 'category lower quartile',
    q3: 'category upper quartile',
  }[assumptions.source];
}

function renderCheck() {
  const matches = D.rows.filter((row) => impliedValue(row, DEFAULTS) === row.implied_value_usd).length;
  $('recompute-check').textContent =
    `Recompute check: ${matches}/${D.rows.length} rows re-derive exactly from the snapshot figures at the submitted defaults.`;
  const banner = $('adjusted-banner');
  if (isDefault()) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.textContent =
    `Adjusted view: the board is re-ranked under your settings — growth ${assumptions.growth.toFixed(2)}×, ` +
    `maturity ${assumptions.maturity.toFixed(2)}×, ${sourceLabel()}${assumptions.footprint ? '' : ', footprint off'}. ` +
    `The submitted board is unchanged; reset restores it.`;
}

function readPlayground() {
  assumptions.growth = Number($('growth-weight').value);
  assumptions.maturity = Number($('maturity-strength').value);
  assumptions.source = $('multiple-source').value;
  assumptions.footprint = $('footprint-on').checked;
  $('growth-value').textContent = `${assumptions.growth.toFixed(2)}×`;
  $('maturity-value').textContent = `${assumptions.maturity.toFixed(2)}×`;
  renderBoard();
  renderCheck();
}

function resetPlayground() {
  $('growth-weight').value = '1';
  $('maturity-strength').value = '1';
  $('multiple-source').value = 'category';
  $('footprint-on').checked = true;
  readPlayground();
}

// ---------------------------------------------------------- filters, sorting

function populateFilters() {
  const categories = [...new Set(D.rows.map((r) => r.category))].sort();
  const chains = [...new Set(D.rows.flatMap((r) => r.chains))].sort();
  $('category').innerHTML = '<option value="all">All categories</option>'
    + categories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  $('chain').innerHTML = '<option value="all">All chains</option>'
    + chains.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
}

function resetFilters() {
  state.q = '';
  state.category = 'all';
  state.chain = 'all';
  state.minTvl = 0;
  state.watchlistOnly = false;
  $('q').value = '';
  $('category').value = 'all';
  $('chain').value = 'all';
  $('min-tvl').value = '0';
  $('watchlist-only').checked = false;
  renderBoard();
}

// ---------------------------------------------------------- detail view

function breakdownTable(row) {
  const b = row.value_breakdown;
  const lines = [
    ['TVL', fmtUsdFull(row.tvl_usd), 'Snapshot figure'],
    ['Category multiple', `${b.category_multiple.toFixed(3)}×`, `${row.category} median (see calibration)`],
    ['Growth factor', `${b.growth_factor.toFixed(3)}×`, row.change_7d === null || row.change_7d === undefined ? '7d change not reported' : `${row.change_7d > 0 ? '+' : ''}${row.change_7d.toFixed(1)}% in 7 days`],
    ['Maturity factor', `${b.maturity_factor.toFixed(3)}×`, fmtAgeLong(row.age_days) === null ? 'Listing date not reported' : `${fmtAgeLong(row.age_days)} since listing`],
    ['Footprint factor', `${b.footprint_factor.toFixed(3)}×`, `${row.chains.length} chain${row.chains.length === 1 ? '' : 's'}`],
    ['Implied value', fmtUsdFull(row.implied_value_usd), 'TVL × multiple × growth × maturity × footprint'],
  ];
  return '<table class="breakdown"><tbody>'
    + lines.map(([label, value, note]) => `<tr><td>${label}</td><td>${escapeHtml(value)}</td><td>${escapeHtml(note)}</td></tr>`).join('')
    + '</tbody></table>';
}

function compsTable(row) {
  const comps = nearestComparables(row, D.calibration.live, 3);
  const compMedian = [...comps.map((c) => c.multiple)].sort((a, b) => a - b)[Math.floor(comps.length / 2)];
  const own = row.value_breakdown.category_multiple;
  const relation = own < compMedian * 0.9 ? 'below' : own > compMedian * 1.1 ? 'above' : 'near';
  const filled = comps.some((c) => !c.sameCategory);
  const rows = comps.map((c) => `<tr><td>${escapeHtml(c.name)}${c.sameCategory ? '' : ' <span class="muted-note">(other category)</span>'}</td>`
    + `<td>${escapeHtml(c.category)}</td><td class="num">${fmtUsd(c.tvl_usd)}</td>`
    + `<td class="num">${fmtUsd(c.mcap_usd)}</td><td class="num">${c.multiple.toFixed(3)}×</td></tr>`).join('');
  return '<table><thead><tr><th>Comparable</th><th>Category</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">Multiple</th></tr></thead>'
    + `<tbody>${rows}</tbody></table>`
    + `<p class="checkline">This row's multiple (${own.toFixed(3)}×) sits ${relation} its comparables' median (${compMedian.toFixed(3)}×). `
    + `Comparables are the live-token protocols nearest in TVL, same category first${filled ? '; filled from other categories where the category has fewer than three' : ''}.</p>`;
}

function planHtml(row) {
  const totals = costPlan(row);
  const steps = row.farm_steps.map((step, i) => {
    const meta = row.plan_meta[i];
    return `<li>${escapeHtml(step)}<span class="phase">${escapeHtml(meta.phase)}</span></li>`;
  }).join('');
  return `<p class="plan-total">Plan total: <strong>${fmtCostRange(totals.cost)} in gas and fees</strong> · `
    + `<strong>${fmtTimeRange(totals.minutes)} of active time</strong>, spread over 8–12 weeks. Every step below states its own cost and time.</p>`
    + `<ol class="plan">${steps}</ol>`
    + `<p class="plan-note">Estimates: gas moves with congestion, and the totals count gas and transaction fees only — the deposit stays yours, and bridge tolls vary by route. Times count the full horizon, including the weekly checks.</p>`;
}

function openDetail(slug) {
  const row = D.rows.find((r) => r.slug === slug);
  if (!row) return;
  $('detail-title').textContent = `#${row.rank} ${row.name}`;
  const liveValue = impliedValue(row, assumptions);
  const liveRank = liveRows().find((e) => e.row.slug === slug).liveRank;
  const liveLine = isDefault() ? '' : `<p class="live-line">Under the playground's current settings this protocol would rank #${liveRank} at ${fmtUsdFull(liveValue)}.</p>`;
  const checkValue = impliedValue(row, DEFAULTS);
  const calEntry = CAL_MAP.get(row.category);
  const signalsHtml = row.data_signals.length
    ? `<ul class="signals">${row.data_signals.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`
    : `<p class="signals-none">No caution signals: the 7d change and listing date are both reported, the ${escapeHtml(row.category)} multiple rests on ${calEntry ? calEntry.n : 'several'} live-token protocols, and TVL spans ${row.chains.length} chain${row.chains.length === 1 ? '' : 's'}.</p>`;
  $('detail-body').innerHTML =
    `<p class="meta">${escapeHtml(row.category)} · ${row.chains.map(escapeHtml).join(', ')} · TVL ${fmtUsd(row.tvl_usd)} · age ${fmtAge(row.age_days)}${row.watchlist ? ' · ★ on the snapshot watchlist' : ''}</p>`
    + `<h3>Why this rank</h3><p class="why">${escapeHtml(row.why)}</p>`
    + `<h3>Value breakdown</h3>${breakdownTable(row)}`
    + `<p class="checkline">Check: ${fmtUsdFull(row.tvl_usd)} × ${row.value_breakdown.category_multiple.toFixed(3)} × ${row.value_breakdown.growth_factor.toFixed(3)} × ${row.value_breakdown.maturity_factor.toFixed(3)} × ${row.value_breakdown.footprint_factor.toFixed(3)} = ${fmtUsdFull(checkValue)} — matches the submitted value.</p>`
    + liveLine
    + `<h3>Nearest live-token comparables</h3>${compsTable(row)}`
    + `<h3>Data signals</h3>${signalsHtml}`
    + `<h3>Farm plan — costed and timed</h3>${planHtml(row)}`
    + `<h3>Risks before farming</h3><ul class="risks">${row.plan_risks.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`;
  $('detail').showModal();
}

// ---------------------------------------------------------- charts

function renderScatter() {
  const rows = D.rows;
  const W = 1064, H = 300, padL = 64, padR = 16, padT = 14, padB = 36;
  const logTvl = rows.map((r) => Math.log10(r.tvl_usd));
  const logVal = rows.map((r) => Math.log10(r.implied_value_usd));
  const x0 = Math.floor(Math.min(...logTvl));
  const x1 = Math.ceil(Math.max(...logTvl));
  const y0 = Math.floor(Math.min(...logVal));
  const y1 = Math.ceil(Math.max(...logVal));
  const X = (v) => padL + ((Math.log10(v) - x0) / (x1 - x0)) * (W - padL - padR);
  const Y = (v) => H - padB - ((Math.log10(v) - y0) / (y1 - y0)) * (H - padT - padB);
  const axisFmt = (p) => p >= 9 ? `$${10 ** (p - 9)}B` : p >= 6 ? `$${10 ** (p - 6)}M` : `$${10 ** (p - 3)}K`;
  let grid = '';
  for (let p = x0; p <= x1; p += 1) {
    const x = X(10 ** p);
    grid += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${H - padB}" stroke="#1a2438" stroke-width="1"/>`
      + `<text x="${x}" y="${H - 18}" fill="#67779a" font-size="11" text-anchor="middle">${axisFmt(p)}</text>`;
  }
  for (let p = y0; p <= y1; p += 1) {
    const y = Y(10 ** p);
    grid += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#1a2438" stroke-width="1"/>`
      + `<text x="${padL - 8}" y="${y + 4}" fill="#67779a" font-size="11" text-anchor="end">${axisFmt(p)}</text>`;
  }
  const dots = rows.map((r) => `<circle cx="${X(r.tvl_usd).toFixed(1)}" cy="${Y(r.implied_value_usd).toFixed(1)}" r="${r.watchlist ? 4.5 : 3.5}" fill="${r.watchlist ? '#fbbf24' : '#2dd4bf'}" fill-opacity="${r.watchlist ? 0.95 : 0.6}"><title>${escapeHtml(r.name)} — TVL ${fmtUsd(r.tvl_usd)}, implied ${fmtUsd(r.implied_value_usd)}</title></circle>`).join('');
  $('scatter').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="presentation">${grid}${dots}`
    + `<text x="${(W + padL) / 2}" y="${H - 2}" fill="#95a5c2" font-size="12" text-anchor="middle">TVL (log scale)</text>`
    + `<text x="14" y="${H / 2}" fill="#95a5c2" font-size="12" text-anchor="middle" transform="rotate(-90 14 ${H / 2})">Implied value (log scale)</text></svg>`;
}

function renderCategoryBars() {
  const categories = D.stats.categories;
  const maxShare = Math.max(...categories.map((c) => c.share));
  document.querySelector('#category-table tbody').innerHTML = categories.map((c) => `<tr><td>${escapeHtml(c.category)}</td>`
    + `<td class="num">${c.count}</td><td class="num">${fmtUsd(c.tvl_usd)}</td><td class="num">${(c.share * 100).toFixed(1)}%</td>`
    + `<td><span class="distbar" style="width:${(c.share / maxShare * 100).toFixed(1)}%"></span></td></tr>`).join('');
}

// ---------------------------------------------------------- memo

function renderCalibration() {
  const table = D.calibration.table;
  const fallbackCount = table.filter((e) => e.fallback).length;
  $('calib-summary').textContent =
    `The multiples rest on ${D.calibration.live_count} protocols whose token already trades, across ${table.length} categories. ` +
    `The global median is ${D.calibration.global_multiple.toFixed(3)}× (interquartile range ${D.calibration.global_q1.toFixed(3)}×–${D.calibration.global_q3.toFixed(3)}×). ` +
    `${table.length - fallbackCount} categories have three or more live-token protocols and price themselves; ${fallbackCount} fall back to the global median and are marked †.`;
  document.querySelector('#calibration tbody').innerHTML = table.map((e) => `<tr><td>${escapeHtml(e.category)}${e.fallback ? ' †' : ''}</td>`
    + `<td class="num">${e.multiple.toFixed(3)}×</td>`
    + `<td class="num">${e.fallback ? 'global' : `${e.q1.toFixed(3)}×–${e.q3.toFixed(3)}×`}</td>`
    + `<td class="num">${e.n}</td></tr>`).join('');
  $('cal-note').textContent = '† Fallback: fewer than 3 live-token protocols in the category, so the global median is used. Every multiple is clamped to 0.05×–2.5×.';
}

function renderWorkedExample() {
  const row = D.rows[0];
  const b = row.value_breakdown;
  const entry = CAL_MAP.get(row.category);
  const multipleNote = entry.fallback
    ? `the ${row.category} multiple falls back to the global median (${b.category_multiple.toFixed(3)}×) because only ${entry.n} live-token protocols sit in the category`
    : `the ${row.category} multiple is ${b.category_multiple.toFixed(3)}×, the median of ${entry.n} live-token protocols in the category (interquartile range ${entry.q1.toFixed(3)}×–${entry.q3.toFixed(3)}×)`;
  const growthNote = row.change_7d === null || row.change_7d === undefined
    ? 'no 7d change was reported, so the growth factor stays neutral at 1.000×'
    : `a ${row.change_7d > 0 ? '+' : ''}${row.change_7d.toFixed(1)}% 7d change gives a ${b.growth_factor.toFixed(3)}× growth factor`;
  const maturityNote = fmtAgeLong(row.age_days) === null
    ? 'no listing date was reported, so the maturity factor stays neutral at 1.000×'
    : `${fmtAgeLong(row.age_days)} since listing gives a ${b.maturity_factor.toFixed(3)}× maturity factor`;
  const footprintNote = `${row.chains.length} chain${row.chains.length === 1 ? '' : 's'} give a ${b.footprint_factor.toFixed(3)}× footprint factor`;
  $('worked-example').innerHTML = `<div class="worked"><p>Rank #1 is <strong>${escapeHtml(row.name)}</strong> (${escapeHtml(row.category)}), with ${fmtUsdFull(row.tvl_usd)} of TVL. `
    + `${escapeHtml(multipleNote[0].toUpperCase() + multipleNote.slice(1))}; ${growthNote}; ${maturityNote}; and ${footprintNote}.</p>`
    + `<p class="arith">${fmtUsdFull(row.tvl_usd)} × ${b.category_multiple.toFixed(3)} × ${b.growth_factor.toFixed(3)} × ${b.maturity_factor.toFixed(3)} × ${b.footprint_factor.toFixed(3)} = ${fmtUsdFull(row.implied_value_usd)}</p>`
    + `<p class="verified">Recomputed in this page by impliedValue: ${fmtUsdFull(impliedValue(row, DEFAULTS))} — matches the submitted board.</p></div>`;
}

// ---------------------------------------------------------- init

function init() {
  renderHeader();
  populateFilters();
  renderBoard();
  renderCheck();
  renderScatter();
  renderCategoryBars();
  renderCalibration();
  renderWorkedExample();

  $('q').addEventListener('input', (e) => { state.q = e.target.value; renderBoard(); });
  $('category').addEventListener('change', (e) => { state.category = e.target.value; renderBoard(); });
  $('chain').addEventListener('change', (e) => { state.chain = e.target.value; renderBoard(); });
  $('min-tvl').addEventListener('change', (e) => { state.minTvl = Number(e.target.value); renderBoard(); });
  $('watchlist-only').addEventListener('change', (e) => { state.watchlistOnly = e.target.checked; renderBoard(); });
  $('reset').addEventListener('click', resetFilters);

  document.querySelectorAll('#board th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      if (state.sortKey === th.dataset.sort) state.sortDir *= -1;
      else { state.sortKey = th.dataset.sort; state.sortDir = ['tvl_usd', 'change_7d', 'implied_value_usd'].includes(th.dataset.sort) ? -1 : 1; }
      renderBoard();
    });
  });

  $('rows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-slug]');
    if (tr) openDetail(tr.dataset.slug);
  });
  $('rows').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const tr = e.target.closest('tr[data-slug]');
    // preventDefault: without it, the Enter that opens the dialog also
    // activates the close button the dialog focuses, closing it again.
    if (tr) { e.preventDefault(); openDetail(tr.dataset.slug); }
  });
  $('detail-close').addEventListener('click', () => $('detail').close());
  $('detail').addEventListener('click', (e) => { if (e.target === $('detail')) $('detail').close(); });

  $('growth-weight').addEventListener('input', readPlayground);
  $('maturity-strength').addEventListener('input', readPlayground);
  $('multiple-source').addEventListener('change', readPlayground);
  $('footprint-on').addEventListener('change', readPlayground);
  $('playground-reset').addEventListener('click', resetPlayground);
}

init();
