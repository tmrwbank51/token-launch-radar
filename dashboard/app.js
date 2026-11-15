// Token Launch Radar: the board's sorting, filtering, and detail view.
// The data arrives in window.RADAR_DATA, written by main.ts from the sealed
// snapshot. No network: everything on the page comes from that one object.

const D = window.RADAR_DATA;
const $ = (id) => document.getElementById(id);

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

function fmtFactor(factor) {
  return `${factor.toFixed(3)}×`;
}

// --------------------------------------------------------------- header

function renderStats() {
  $('stats').innerHTML = [
    `<span class="chip"><strong>${D.protocols}</strong> protocols scanned</span>`,
    `<span class="chip"><strong>${D.board_rows}</strong> on the board</span>`,
    `<span class="chip">Watchlist <strong class="ok">${D.watchlist_covered}/${D.watchlist}</strong> covered</span>`,
    `<span class="chip">Board TVL <strong>${fmtUsd(D.board_tvl_usd)}</strong></span>`,
    `<span class="chip">Snapshot <strong>${escapeHtml(D.as_of)}</strong></span>`,
  ].join('');
}

function renderMethodNote() {
  const calibrated = D.calibration.reduce((sum, row) => sum + row.n, 0);
  $('method-note').textContent =
    `Calibrated on ${calibrated} protocols whose token already trades, across ${D.calibration.length} categories ` +
    `(global multiple ${D.global_multiple.toFixed(3)}×). Every row below records no token in the snapshot. ` +
    `Click a row for its value breakdown and farm plan; click a column header to sort.`;
}

function renderSourceNote() {
  $('source-note').textContent =
    `Source: the sealed DefiLlama protocols snapshot, frozen ${D.as_of} (watchlist floor ${fmtUsd(D.floor_usd)}). ` +
    `${D.protocols} protocols scanned, ${D.pre_token} record no token, ${D.board_rows} on the board after leaving out ` +
    `wrapped, staked and bridged products of tokens that already trade.`;
}

function renderCalibration() {
  const body = document.querySelector('#calibration tbody');
  body.innerHTML = D.calibration
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.category)}</td><td class="num">${row.multiple.toFixed(3)}×${row.fallback ? ' *' : ''}</td><td class="num">${row.n}</td></tr>`,
    )
    .join('');
  if (D.calibration.some((row) => row.fallback)) {
    $('cal-note').textContent = '* Global median: fewer than three live-token protocols in the category, so the category multiple falls back to the global one.';
  }
}

// The value model, recomputed in the page from the stored breakdown: the same
// multiplication main.ts ran. The detail view shows the check line so a
// reader can see the implied value follow from the snapshot's figures.
function recomputeValue(row) {
  const b = row.value_breakdown;
  return Math.round(row.tvl_usd * b.category_multiple * b.growth_factor * b.maturity_factor * b.footprint_factor);
}

// --------------------------------------------------------------- filters

function populateSelects() {
  const categories = [...new Set(D.rows.map((r) => r.category))].sort();
  for (const category of categories) {
    $('category').insertAdjacentHTML('beforeend', `<option>${escapeHtml(category)}</option>`);
  }
  const chainCounts = new Map();
  for (const row of D.rows) for (const chain of row.chains) chainCounts.set(chain, (chainCounts.get(chain) ?? 0) + 1);
  const chains = [...chainCounts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([name]) => name);
  for (const chain of chains) {
    $('chain').insertAdjacentHTML('beforeend', `<option>${escapeHtml(chain)}</option>`);
  }
}

function filteredRows() {
  const q = state.q.trim().toLowerCase();
  return D.rows.filter((row) => {
    if (q && !row.name.toLowerCase().includes(q) && !row.slug.toLowerCase().includes(q)) return false;
    if (state.category !== 'all' && row.category !== state.category) return false;
    if (state.chain !== 'all' && !row.chains.includes(state.chain)) return false;
    if (row.tvl_usd < state.minTvl) return false;
    if (state.watchlistOnly && !row.watchlist) return false;
    return true;
  });
}

function sortValue(row, key) {
  if (key === 'chains') return row.chains.length;
  if (key === 'name' || key === 'category') return row[key];
  return row[key];
}

function sortedRows(rows) {
  const { sortKey, sortDir } = state;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, sortKey);
    const vb = sortValue(b, sortKey);
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    if (typeof va === 'string') return va.localeCompare(vb) * sortDir;
    if (va !== vb) return (va - vb) * sortDir;
    return a.rank - b.rank;
  });
}

// --------------------------------------------------------------- the board

function renderRows() {
  const rows = sortedRows(filteredRows());
  const maxValue = D.rows[0].implied_value_usd;
  const body = $('rows');
  if (rows.length === 0) {
    body.innerHTML = `<tr><td class="empty" colspan="9">No protocol matches these filters. Loosen one and try again.</td></tr>`;
  } else {
    body.innerHTML = rows
      .map((row) => {
        const change = fmtPct(row.change_7d);
        const width = Math.max(2, (row.implied_value_usd / maxValue) * 100);
        return `<tr tabindex="0" data-slug="${escapeHtml(row.slug)}">
          <td class="num rank">${row.rank}</td>
          <td class="name-cell"><span class="name">${escapeHtml(row.name)}</span>${
            row.watchlist ? '<span class="badge">WATCHLIST</span>' : ''
          }<br><span class="slug">${escapeHtml(row.slug)}</span></td>
          <td class="cat">${escapeHtml(row.category)}</td>
          <td class="chains" title="${escapeHtml(row.chains.join(', '))}">${escapeHtml(row.chains.slice(0, 3).join(', '))}${
            row.chains.length > 3 ? ` +${row.chains.length - 3}` : ''
          }</td>
          <td class="num">${fmtUsd(row.tvl_usd)}</td>
          <td class="num ${change.cls}">${change.text}</td>
          <td class="num">${fmtAge(row.age_days)}</td>
          <td class="num value-cell"><span class="amount">${fmtUsd(row.implied_value_usd)}</span><span class="bar"><i style="width:${width.toFixed(1)}%"></i></span></td>
          <td class="num steps-n">${row.farm_steps.length} steps</td>
        </tr>`;
      })
      .join('');
  }
  $('count').textContent = `Showing ${rows.length} of ${D.rows.length} protocols · sorted by ${state.sortKey.replace('_', ' ')} ${
    state.sortDir === 1 ? 'ascending' : 'descending'
  }.`;
  for (const tr of body.querySelectorAll('tr[data-slug]')) {
    tr.addEventListener('click', () => openDetail(tr.dataset.slug));
    tr.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openDetail(tr.dataset.slug);
      }
    });
  }
  for (const th of document.querySelectorAll('#board thead th[data-sort]')) {
    th.classList.toggle('sorted', th.dataset.sort === state.sortKey);
    th.classList.toggle('asc', th.dataset.sort === state.sortKey && state.sortDir === 1);
  }
}

// --------------------------------------------------------------- detail view

function openDetail(slug) {
  const row = D.rows.find((r) => r.slug === slug);
  if (!row) return;
  const b = row.value_breakdown;
  const change = fmtPct(row.change_7d);
  $('detail-title').textContent = row.name;
  $('detail-body').innerHTML = `
    <p class="meta">
      <span>Rank <strong>#${row.rank}</strong></span>
      <span>${escapeHtml(row.category)}</span>
      <span>${escapeHtml(row.chains.join(', '))}</span>
      <span>${row.watchlist ? 'On the watchlist' : 'Below the watchlist floor'}</span>
      <span>Records no token</span>
    </p>
    <h3>Implied value breakdown</h3>
    <table class="breakdown">
      <tr><td>TVL <span class="dim">(snapshot)</span></td><td>${fmtUsd(row.tvl_usd)}</td></tr>
      <tr><td>Category multiple <span class="dim">(median mcap/TVL, ${escapeHtml(row.category)})</span></td><td>${fmtFactor(b.category_multiple)}</td></tr>
      <tr><td>Growth factor <span class="dim">(7d ${change.text})</span></td><td>${fmtFactor(b.growth_factor)}</td></tr>
      <tr><td>Maturity factor <span class="dim">(listed ${escapeHtml(row.listed_at ?? 'unknown')}, age ${fmtAge(row.age_days)})</span></td><td>${fmtFactor(b.maturity_factor)}</td></tr>
      <tr><td>Footprint factor <span class="dim">(${row.chains.length} chain${row.chains.length === 1 ? '' : 's'})</span></td><td>${fmtFactor(b.footprint_factor)}</td></tr>
      <tr class="total"><td>Implied value</td><td>${fmtUsd(row.implied_value_usd)}</td></tr>
    </table>
    <p class="check-line">Check: ${fmtUsd(row.tvl_usd)} × ${b.category_multiple.toFixed(3)} × ${b.growth_factor.toFixed(3)} × ${b.maturity_factor.toFixed(3)} × ${b.footprint_factor.toFixed(3)} = ${fmtUsd(recomputeValue(row))}</p>
    <h3>Farm plan — ${row.farm_steps.length} steps</h3>
    <ol class="plan">${row.farm_steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>
    <p class="meta">Implied value is this entry's own claim. The plan is a starting point, not financial advice.</p>`;
  $('detail').showModal();
}

function wireDialog() {
  const dialog = $('detail');
  $('detail-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
}

// --------------------------------------------------------------- wiring

function wireFilters() {
  $('q').addEventListener('input', (event) => {
    state.q = event.target.value;
    renderRows();
  });
  $('category').addEventListener('change', (event) => {
    state.category = event.target.value;
    renderRows();
  });
  $('chain').addEventListener('change', (event) => {
    state.chain = event.target.value;
    renderRows();
  });
  $('min-tvl').addEventListener('change', (event) => {
    state.minTvl = Number(event.target.value);
    renderRows();
  });
  $('watchlist-only').addEventListener('change', (event) => {
    state.watchlistOnly = event.target.checked;
    renderRows();
  });
  $('reset').addEventListener('click', () => {
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
    renderRows();
  });
  for (const th of document.querySelectorAll('#board thead th[data-sort]')) {
    th.addEventListener('click', () => {
      if (state.sortKey === th.dataset.sort) {
        state.sortDir = -state.sortDir;
      } else {
        state.sortKey = th.dataset.sort;
        // Rank, names and categories read best ascending first; measures
        // (TVL, value, growth, age) read best largest first.
        state.sortDir = th.dataset.sort === 'name' || th.dataset.sort === 'category' || th.dataset.sort === 'rank' ? 1 : -1;
      }
      renderRows();
    });
  }
}

renderStats();
renderMethodNote();
renderSourceNote();
renderCalibration();
populateSelects();
wireFilters();
wireDialog();
renderRows();
