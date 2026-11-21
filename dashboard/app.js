/* Token Launch Radar: the page.
   It reruns the model in model.js on the sealed snapshot (data.js), checks its values against the
   board.json values shipped beside it, and renders the board, its filters and one protocol's detail.
   Every view lives in the URL hash, so each can be linked:  #/?q=&cat=&verdict=&conf=&watch=1&sort=&dir=   #/p/<slug> */
(function () {
  'use strict';

  const M = window.RadarModel;
  const radar = M.buildRadar(window.RADAR_SNAPSHOT);
  const bySlug = {};
  radar.rows.forEach((r) => {
    bySlug[r.slug] = r;
  });
  const top = document.getElementById('top');
  const view = document.getElementById('view');
  const usd = M.usd;

  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const change = (x) => (x === null ? 'unreported' : (x >= 0 ? '+' : '') + x.toFixed(1) + '%');
  const tokenless = (d) => (d === null ? 'unknown' : d < 60 ? d + ' days' : d < 730 ? Math.round(d / 30.44) + ' months' : (d / 365.25).toFixed(1) + ' years');
  const times = (x) => '×' + x.toFixed(2);
  const CONFIDENCE = ['high', 'medium', 'low'];

  const COLUMNS = [
    { key: 'rank', label: '#', num: true, get: (r) => r.rank, cell: (r) => r.rank },
    { key: 'name', label: 'Protocol', get: (r) => r.name.toLowerCase(), cell: (r) => '<a href="#/p/' + encodeURIComponent(r.slug) + '">' + esc(r.name) + '</a>' + (r.watchlist ? '<span class="tag">watchlist</span>' : '') },
    { key: 'category', label: 'Category', get: (r) => r.category, cell: (r) => esc(r.category) },
    { key: 'chain', label: 'Main chain', get: (r) => r.farm.chain, cell: (r) => esc(r.farm.chain) + (r.chains.length > 1 ? ' <span class="muted">+' + (r.chains.length - 1) + '</span>' : '') },
    { key: 'tvl', label: 'TVL', num: true, get: (r) => r.tvl_usd, cell: (r) => usd(r.tvl_usd) },
    { key: 'change', label: '7d TVL', num: true, get: (r) => (r.change_7d === null ? -Infinity : r.change_7d), cell: (r) => '<span class="' + (r.change_7d === null ? 'muted' : r.change_7d < 0 ? 'neg' : 'pos') + '">' + change(r.change_7d) + '</span>' },
    { key: 'age', label: 'Tokenless for', num: true, get: (r) => (r.age_days === null ? -Infinity : r.age_days), cell: (r) => tokenless(r.age_days) },
    { key: 'implied', label: 'Implied value', num: true, get: (r) => r.implied_value_usd, cell: (r) => '<strong>' + usd(r.implied_value_usd) + '</strong>' },
    { key: 'net', label: 'Farm net', num: true, get: (r) => r.farm.net, cell: (r) => '<span class="' + (r.farm.net > 0 ? 'pos' : 'neg') + '">' + usd(r.farm.net) + '</span>' },
    { key: 'verdict', label: 'Verdict', get: (r) => r.farm.verdict, cell: (r) => '<span class="verdict ' + r.farm.verdict + '">' + r.farm.verdict + '</span>' },
    { key: 'conf', label: 'Confidence', get: (r) => CONFIDENCE.indexOf(r.confidence), cell: (r) => r.confidence },
  ];

  const BLANK = { q: '', cat: '', verdict: '', conf: '', watch: false, sort: 'rank', dir: 1, slug: null };
  let state = Object.assign({}, BLANK);

  function parseHash() {
    const s = Object.assign({}, BLANK);
    const h = location.hash.replace(/^#\/?/, '');
    if (h.indexOf('p/') === 0) {
      s.slug = decodeURIComponent(h.slice(2));
      return s;
    }
    new URLSearchParams(h.replace(/^\?/, '')).forEach((v, k) => {
      if (k === 'watch') s.watch = v === '1';
      else if (k === 'dir') s.dir = v === 'desc' ? -1 : 1;
      else if (k in s) s[k] = v;
    });
    return s;
  }

  function hashFor(s) {
    const p = new URLSearchParams();
    ['q', 'cat', 'verdict', 'conf'].forEach((k) => {
      if (s[k]) p.set(k, s[k]);
    });
    if (s.watch) p.set('watch', '1');
    if (s.sort !== 'rank' || s.dir !== 1) {
      p.set('sort', s.sort);
      p.set('dir', s.dir === 1 ? 'asc' : 'desc');
    }
    const q = p.toString();
    return '#/' + (q ? '?' + q : '');
  }

  /** The rows the filters keep, in the order the sorted column gives. */
  function visibleRows() {
    const q = state.q.trim().toLowerCase();
    const col = COLUMNS.find((c) => c.key === state.sort) || COLUMNS[0];
    return radar.rows
      .filter((r) => (!q || (r.name + ' ' + r.slug + ' ' + r.category + ' ' + r.chains.join(' ')).toLowerCase().indexOf(q) >= 0) && (!state.cat || r.category === state.cat) && (!state.verdict || r.farm.verdict === state.verdict) && (!state.conf || r.confidence === state.conf) && (!state.watch || r.watchlist))
      .sort((a, b) => {
        const x = col.get(a);
        const y = col.get(b);
        return (x < y ? -1 : x > y ? 1 : 0) * state.dir || a.rank - b.rank;
      });
  }

  /** The header: what the snapshot holds, where each protocol went, and how the model was tested. */
  function renderTop() {
    const c = radar.counts;
    const cv = radar.model.cv;
    const asideTotal = c.pre - c.ranked - c.unscored;
    const onWatch = radar.rows.filter((r) => r.watchlist).length;
    const agree = radar.rows.filter((r) => window.RADAR_BOARD[r.slug] === r.implied_value_usd).length;
    const model = radar.model.winner === 'A' ? 'category multiples' : 'curve fitted to ' + radar.model.comps + ' traded tokens' + (radar.model.guard ? ', read only inside their range' : '');
    top.innerHTML =
      '<h1>Token Launch Radar</h1>' +
      '<p class="lede">Protocols that record no token on DefiLlama, ranked by what a launch would be worth if their record stayed as it is, each with a costed plan to farm it. ' +
      'Snapshot of ' + esc(radar.as_of) + '. An implied value is this model\'s claim, not a forecast that a token is issued.</p>' +
      '<dl class="strip">' +
      '<div><dt>In the snapshot</dt><dd>' + c.total + ' protocols</dd></div>' +
      '<div><dt>Ranked here</dt><dd>' + c.ranked + ' <small>record no token</small></dd></div>' +
      '<div><dt>Watchlist covered</dt><dd>' + onWatch + ' / ' + window.RADAR_SNAPSHOT.watchlist.length + '</dd></div>' +
      '<div><dt>Set aside</dt><dd>' + asideTotal + ' <small>bridged, staked, exchange, versioned or kin of a traded token</small></dd></div>' +
      '<div><dt>Token already trades</dt><dd>' + c.live + ' <small>+ ' + c.recorded + ' with a ticker only</small></dd></div>' +
      '<div><dt>Value model</dt><dd>' + esc(model) + '</dd></div>' +
      '<div><dt>Held-out error (median |ln|)</dt><dd>' + cv.G.median.toFixed(2) + ' <small>vs ' + cv.A.median.toFixed(2) + ' for category multiples</small></dd></div>' +
      '<div><dt>Recomputed in this browser</dt><dd>' + agree + ' / ' + c.ranked + ' <small>match board.json</small></dd></div>' +
      '</dl>';
  }

  function renderRows() {
    const rows = visibleRows();
    view.querySelector('.count').textContent = rows.length + ' of ' + radar.rows.length + ' protocols';
    view.querySelector('thead tr').innerHTML = COLUMNS.map((c) => '<th data-key="' + c.key + '" class="' + (c.num ? 'num' : '') + (c.key === state.sort ? ' sorted' : '') + '">' + c.label + (c.key === state.sort ? (state.dir === 1 ? ' ▲' : ' ▼') : '') + '</th>').join('');
    view.querySelector('tbody').innerHTML = rows.length
      ? rows.map((r) => '<tr>' + COLUMNS.map((c) => '<td class="' + (c.num ? 'num' : '') + '">' + c.cell(r) + '</td>').join('') + '</tr>').join('')
      : '<tr><td class="empty" colspan="' + COLUMNS.length + '">No protocol matches these filters.</td></tr>';
  }

  function renderBoard() {
    const options = (values, chosen) => values.map((v) => '<option value="' + esc(v) + '"' + (v === chosen ? ' selected' : '') + '>' + esc(v) + '</option>').join('');
    const categories = Array.from(new Set(radar.rows.map((r) => r.category))).sort();
    view.innerHTML =
      '<div class="filters">' +
      '<input type="search" id="f-q" placeholder="Search protocol, category or chain" value="' + esc(state.q) + '">' +
      '<select id="f-cat"><option value="">All categories</option>' + options(categories, state.cat) + '</select>' +
      '<select id="f-verdict"><option value="">Any verdict</option>' + options(['farm', 'thin', 'skip'], state.verdict) + '</select>' +
      '<select id="f-conf"><option value="">Any confidence</option>' + options(CONFIDENCE, state.conf) + '</select>' +
      '<label><input type="checkbox" id="f-watch"' + (state.watch ? ' checked' : '') + '> Watchlist only</label>' +
      '<button type="button" id="f-reset">Reset</button>' +
      '<span class="count"></span>' +
      '</div>' +
      '<table><thead><tr></tr></thead><tbody></tbody></table>';
    const set = (patch) => {
      Object.assign(state, patch);
      history.replaceState(null, '', hashFor(state));
      renderRows();
    };
    view.querySelector('#f-q').addEventListener('input', (e) => set({ q: e.target.value }));
    view.querySelector('#f-cat').addEventListener('change', (e) => set({ cat: e.target.value }));
    view.querySelector('#f-verdict').addEventListener('change', (e) => set({ verdict: e.target.value }));
    view.querySelector('#f-conf').addEventListener('change', (e) => set({ conf: e.target.value }));
    view.querySelector('#f-watch').addEventListener('change', (e) => set({ watch: e.target.checked }));
    view.querySelector('#f-reset').addEventListener('click', () => {
      location.hash = '#/';
    });
    view.querySelector('thead').addEventListener('click', (e) => {
      const th = e.target.closest('th');
      if (!th) return;
      const key = th.getAttribute('data-key');
      set(key === state.sort ? { dir: -state.dir } : { sort: key, dir: key === 'rank' || key === 'name' || key === 'category' || key === 'chain' ? 1 : -1 });
    });
    renderRows();
  }

  function renderDetail(r) {
    const f = r.farm;
    const p = r.parts;
    const fact = (label, value) => '<div><span class="k">' + label + '</span>' + value + '</div>';
    view.innerHTML =
      '<p><a href="#/">← Back to the board</a></p>' +
      '<article class="detail">' +
      '<header><h2>#' + r.rank + ' ' + esc(r.name) + (r.watchlist ? '<span class="tag">watchlist</span>' : '') + '</h2>' +
      '<p>' + esc(r.category) + ' · ' + esc(r.chains.join(', ')) + ' · records no token on DefiLlama as of ' + esc(radar.as_of) + '</p></header>' +
      '<div>' +
      '<section class="card"><h3>Implied launch value</h3><p class="big">' + usd(r.implied_value_usd) + '</p>' +
      '<table><tbody>' +
      '<tr><td>TVL ' + usd(r.tvl_usd) + ' on the fitted curve</td><td class="num">' + usd(p.base) + '</td></tr>' +
      '<tr><td>7-day TVL change: ' + change(r.change_7d) + '</td><td class="num">' + times(p.growth) + '</td></tr>' +
      '<tr><td>Tokenless for: ' + tokenless(r.age_days) + (r.listed_at ? ' (tracked since ' + esc(r.listed_at) + ')' : '') + '</td><td class="num">' + times(p.age) + '</td></tr>' +
      '<tr><td>Implied value</td><td class="num">' + usd(r.implied_value_usd) + '</td></tr>' +
      '</tbody></table>' +
      '<p class="muted" style="margin-top:8px">Confidence: ' + r.confidence + '</p>' +
      (r.notes.length ? '<ul class="notes">' + r.notes.map((n) => '<li>' + esc(n) + '</li>').join('') + '</ul>' : '') +
      '</section>' +
      '</div>' +
      '<section class="card"><h3>Farm plan</h3>' +
      '<div class="budget">' +
      fact('Position', usd(f.deposit)) + fact('Weeks', f.weeks) + fact('Fees', usd(f.cost)) + fact('Time', f.hours.toFixed(1) + ' h') +
      fact('Modelled share', usd(f.drop)) + fact('Net', '<span class="' + (f.net > 0 ? 'pos' : 'neg') + '">' + usd(f.net) + '</span>') +
      fact('Verdict', '<span class="verdict ' + f.verdict + '">' + f.verdict + '</span>') +
      '</div>' +
      '<ol class="steps">' + f.steps.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ol>' +
      '</section>' +
      '</article>';
  }

  function render() {
    state = parseHash();
    const row = state.slug === null ? null : bySlug[state.slug];
    if (state.slug !== null && !row) {
      view.innerHTML = '<p class="empty">No ranked protocol has the slug "' + esc(state.slug) + '". <a href="#/">Back to the board</a></p>';
      return;
    }
    if (row) renderDetail(row);
    else renderBoard();
    window.scrollTo(0, 0);
  }

  renderTop();
  window.addEventListener('hashchange', render);
  render();
})();
