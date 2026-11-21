/* Token Launch Radar: the page.
   It reruns model.js on the sealed snapshot (../data.js, written by main.ts), checks the result against
   board.json's values (selfChecks), and draws four views: the ranked board, the traded tokens the
   curve is fitted on, tickers on record, and what was set aside. Every view is a URL:
   #/?tab=&q=&cat=&tier=&verdict=&conf=&sort=&dir=&dep=&share=   #/p/<slug> */
(function () {
  'use strict';

  const M = window.RadarModel;
  const snap = window.RADAR_SNAPSHOT;
  const radar = M.buildRadar(snap);
  const rows = radar.rows;
  const model = radar.model;
  const T = model.test;
  const usd = M.usd;
  const app = document.getElementById('app');
  const bySlug = {};
  rows.forEach((r) => {
    bySlug[r.slug] = r;
  });

  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const signed = (n) => (n > 0 ? '+' : '') + usd(n);
  const pct = (x) => (x === null ? 'unreported' : (x >= 0 ? '+' : '') + x.toFixed(1) + '%');
  const since = (d) => (d === null ? 'unknown' : d < 60 ? d + ' d' : d < 730 ? Math.round(d / 30.44) + ' mo' : (d / 365.25).toFixed(1) + ' yr');
  const miss = (ln) => '×' + Math.exp(ln).toFixed(2); // a median |ln| miss read as a multiple: ×2 is half or double
  const short = (d) => '$' + (d >= 1e9 ? d / 1e9 + 'B' : d >= 1e6 ? d / 1e6 + 'M' : d / 1e3 + 'K');
  const sub = (s) => '<small>' + s + '</small>';
  const tone = (n) => (n > 0 ? 'pos' : 'neg');
  const badge = (v) => '<span class="verdict ' + v + '">' + v + '</span>';
  const CONF = ['high', 'medium', 'low'];
  const TIER = { watchlist: 'watchlist', offlist: 'off list', below: 'below floor' };
  const REASON = {
    category: 'bridge, liquid staking or exchange category: another token carried across',
    version: 'versioned release of one protocol',
    family: 'kin of a protocol that records a token',
    wrapped: 'wrapped or staked by name',
    exchange: 'exchange-named product',
  };

  // ---- State: everything a view needs is in the URL hash -------------------------------------------

  const BLANK = { tab: 'board', q: '', cat: '', tier: '', verdict: '', conf: '', sort: '', dir: '', dep: '', share: '', slug: null };
  let state = Object.assign({}, BLANK);
  let boardHash = '#/';

  function parseHash() {
    const s = Object.assign({}, BLANK);
    const h = location.hash.replace(/^#\/?/, '');
    if (h.indexOf('p/') === 0) {
      s.slug = decodeURIComponent(h.slice(2));
      return s;
    }
    new URLSearchParams(h.replace(/^\?/, '')).forEach((v, k) => {
      if (k in s && k !== 'slug') s[k] = v;
    });
    if (!VIEWS[s.tab]) s.tab = 'board';
    return s;
  }

  function hashFor(s) {
    const p = new URLSearchParams();
    Object.keys(BLANK).forEach((k) => {
      if (s[k] && s[k] !== BLANK[k]) p.set(k, s[k]);
    });
    const q = p.toString();
    return '#/' + (q ? '?' + q : '');
  }

  const href = (patch) => esc(hashFor(Object.assign({}, state, patch)));
  const chip = (patch, label, on) => '<a class="chip' + (on ? ' on' : '') + '" href="' + href(patch) + '">' + label + '</a>';

  /** A row's farm plan under the scenario in the URL; with none chosen it is the plan board.json carries. */
  function planOf(r) {
    return state.dep || state.share ? M.farmPlan(r, radar.as_of, { deposit: +state.dep, share: +state.share / 100 }) : r.farm;
  }

  // ---- The four views of the snapshot ----------------------------------------------------------------

  const lnLo = Math.log(Math.min.apply(null, rows.map((r) => r.range[0])));
  const lnHi = Math.log(Math.max.apply(null, rows.map((r) => r.range[1])));
  const at = (v) => ((Math.log(v) - lnLo) / (lnHi - lnLo)) * 100;

  /** One row's middle-half range on a log scale shared by the whole board, with a tick at its implied value. */
  function rangeBar(r) {
    const a = at(r.range[0]);
    return '<span class="range"><i style="left:' + a.toFixed(1) + '%;width:' + (at(r.range[1]) - a).toFixed(1) + '%"></i><u style="left:' + at(r.implied_value_usd).toFixed(1) + '%"></u></span>';
  }

  const blindMiss = (r) => Math.abs(Math.log(r.mcap_usd / r.blind));
  const nameCol = { k: 'name', label: 'Protocol', up: 1, get: (r) => r.name.toLowerCase(), cell: (r) => esc(r.name) + (r.symbol ? ' <span class="muted">' + esc(r.symbol) + '</span>' : '') + sub(esc(r.category)) };
  const tvlCol = { k: 'tvl', label: 'TVL', num: 1, get: (r) => r.tvl_usd, cell: (r) => usd(r.tvl_usd) };
  const VIEWS = {
    board: {
      label: 'No token recorded',
      rows: rows,
      note: 'Ranked by implied value. Net of fees is the position’s modelled share of the launch minus the plan’s fees; board.json carries the default scenario (plan size, 5% drop share).',
      cols: [
        { k: 'rank', label: '#', num: 1, up: 1, get: (r) => r.rank, cell: (r) => r.rank },
        { k: 'name', label: 'Protocol', up: 1, get: (r) => r.name.toLowerCase(), cell: (r) => '<a class="name" href="#/p/' + encodeURIComponent(r.slug) + '">' + esc(r.name) + '</a><span class="tag ' + r.tier + '">' + TIER[r.tier] + '</span>' + sub(esc(r.category) + ' · ' + esc(r.farm.chain) + (r.chains.length > 1 ? ' +' + (r.chains.length - 1) : '')) },
        tvlCol,
        { k: 'change', label: '7d TVL', num: 1, get: (r) => r.change_7d, cell: (r) => '<span class="' + (r.change_7d === null ? 'muted' : tone(r.change_7d)) + '">' + pct(r.change_7d) + '</span>' },
        { k: 'age', label: 'No token for', num: 1, get: (r) => r.age_days, cell: (r) => since(r.age_days) },
        { k: 'implied', label: 'Implied · middle half', num: 1, get: (r) => r.implied_value_usd, cell: (r) => '<b>' + usd(r.implied_value_usd) + '</b>' + rangeBar(r) + sub(usd(r.range[0]) + ' to ' + usd(r.range[1])) },
        { k: 'net', label: 'Net of fees', num: 1, get: (r) => r.plan.net, cell: (r) => badge(r.plan.verdict) + ' <b class="' + tone(r.plan.net) + '">' + signed(r.plan.net) + '</b>' + sub('on ' + usd(r.plan.deposit) + ' · ' + usd(r.plan.cost) + ' fees') },
        { k: 'hour', label: 'Net / hour', num: 1, get: (r) => r.plan.perHour, cell: (r) => '<span class="' + tone(r.plan.perHour) + '">' + signed(r.plan.perHour) + '</span>' + sub(r.plan.hours.toFixed(1) + ' h · ' + r.plan.weeks + ' wk') },
        { k: 'conf', label: 'Confidence', get: (r) => CONF.indexOf(r.confidence), cell: (r) => '<span class="conf ' + r.confidence + '">' + r.confidence + '</span>' },
      ],
    },
    traded: {
      label: 'Token trades',
      rows: radar.traded,
      note: 'These tokens already trade, so they are never ranked. The ' + T.n + ' with a market cap are the comps the curve is fitted on; “priced blind” is what a fit that never saw the token said.',
      cols: [
        nameCol,
        tvlCol,
        { k: 'cap', label: 'Market cap', num: 1, get: (r) => r.mcap_usd, cell: (r) => (r.mcap_usd ? usd(r.mcap_usd) : '<span class="muted">no cap reported</span>') },
        { k: 'ratio', label: 'Cap / TVL', num: 1, get: (r) => r.mcap_usd && r.mcap_usd / r.tvl_usd, cell: (r) => (r.mcap_usd ? (r.mcap_usd / r.tvl_usd).toFixed(2) : '') },
        { k: 'blind', label: 'Priced blind', num: 1, get: (r) => r.blind, cell: (r) => (r.blind ? usd(r.blind) : '') },
        { k: 'miss', label: 'Miss', num: 1, get: (r) => r.blind && blindMiss(r), cell: (r) => (r.blind ? miss(blindMiss(r)) + sub(r.mcap_usd > r.blind ? 'priced too low' : 'priced too high') : '') },
      ],
    },
    ticker: {
      label: 'Ticker on record',
      rows: radar.ticker,
      note: 'A ticker is on record with no CoinGecko id and no cap: a token exists, so these are neither ranked nor used as comps.',
      cols: [nameCol, tvlCol],
    },
    aside: {
      label: 'Set aside',
      rows: radar.aside,
      note: 'These record no token, yet are a product of something that has one (setAsideReason, tokenKin). A watchlist protocol is never set aside.',
      cols: [nameCol, tvlCol, { k: 'reason', label: 'Why it is not a launch to come', up: 1, get: (r) => r.reason, cell: (r) => REASON[r.reason] + (r.kin.length ? sub('kin: ' + esc(r.kin.join(', '))) : '') }],
    },
  };

  /** The rows the filters keep, in the order the sorted column gives, as a table. */
  function table(view) {
    const key = state.sort || (state.tab === 'board' ? 'rank' : 'tvl');
    const col = view.cols.find((c) => c.k === key) || view.cols[0];
    const dir = state.dir ? (state.dir === 'asc' ? 1 : -1) : col.up ? 1 : -1;
    const q = state.q.trim().toLowerCase();
    const onBoard = state.tab === 'board';
    const list = view.rows
      .filter((r) => (!q || (r.name + ' ' + r.slug + ' ' + r.category + ' ' + (r.chains || []).join(' ')).toLowerCase().indexOf(q) >= 0) && (!state.cat || r.category === state.cat) && (!onBoard || ((!state.tier || r.tier === state.tier) && (!state.verdict || r.plan.verdict === state.verdict) && (!state.conf || r.confidence === state.conf))))
      .sort((a, b) => {
        const x = col.get(a);
        const y = col.get(b);
        if (x === null || y === null) return (x === null) - (y === null) || b.tvl_usd - a.tvl_usd; // unreported sorts last
        return (x < y ? -1 : x > y ? 1 : 0) * dir || b.tvl_usd - a.tvl_usd;
      });
    const head = view.cols.map((c) => '<th class="' + (c.num ? 'num' : '') + (c.k === col.k ? ' sorted' : '') + '"><a href="' + href({ sort: c.k, dir: c.k === col.k ? (dir === 1 ? 'desc' : 'asc') : '' }) + '">' + c.label + (c.k === col.k ? (dir === 1 ? ' ▲' : ' ▼') : '') + '</a></th>').join('');
    const body = list.length ? list.map((r) => '<tr>' + view.cols.map((c) => '<td' + (c.num ? ' class="num"' : '') + '>' + c.cell(r) + '</td>').join('') + '</tr>').join('') : '<tr><td class="empty" colspan="' + view.cols.length + '">No protocol matches these filters.</td></tr>';
    return {
      count: list.length + ' of ' + view.rows.length + ' shown' + (onBoard ? ' · ' + usd(list.reduce((s, r) => s + r.implied_value_usd, 0)) + ' implied in view' : ''),
      html: '<table class="grid"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>',
    };
  }

  // ---- Proof strip: the page checks itself, counts every protocol and states how far to trust it ---

  /** Each check is computed here, in the browser, from the rerun model and the values main.ts wrote. */
  function selfChecks() {
    const c = radar.counts;
    const same = rows.filter((r) => window.RADAR_BOARD[r.slug] === r.implied_value_usd).length;
    const ordered = rows.every((r, i) => r.rank === i + 1 && (i === 0 || r.implied_value_usd <= rows[i - 1].implied_value_usd));
    const covered = snap.watchlist.filter((s) => bySlug[s]).length;
    const costed = rows.filter((r) => r.farm.lines.length >= 3 && r.farm.lines.every((s) => s.length >= 20 && s.length <= 600 && s.indexOf('$') >= 0)).length;
    return [
      [same === rows.length && Object.keys(window.RADAR_BOARD).length === rows.length, 'this table = board.json: ' + same + ' of ' + rows.length + ' values recomputed here'],
      [ordered, 'ranks 1 to ' + rows.length + ' in order, values never rise'],
      [covered === snap.watchlist.length, 'watchlist ' + covered + ' of ' + snap.watchlist.length + ' ranked'],
      [rows.length + c.unscored + radar.aside.length + c.live + c.recorded === c.total, 'ledger ' + rows.length + ' + ' + radar.aside.length + ' + ' + c.live + ' + ' + c.recorded + ' = ' + c.total + ' protocols, one group each'],
      [costed === rows.length, costed + ' of ' + rows.length + ' farm plans costed and timed'],
    ];
  }

  function proof() {
    const c = radar.counts;
    const a = c.aside;
    const n = (fn) => rows.filter(fn).length;
    const ch = T.chosen;
    const best = rows.slice().sort((x, y) => y.plan.perHour - x.plan.perHour)[0];
    const kpi = (label, big, small, cls) => '<div class="kpi"><span class="k">' + label + '</span><b class="' + (cls || '') + '">' + big + '</b>' + sub(small) + '</div>';
    const ledger = [
      ['ranked', rows.length, 'ranked here: records no token and stands alone'],
      ['traded', c.live, 'token trades: the ' + T.n + ' with a market cap are the comps, never ranked'],
      ['ticker', c.recorded, 'ticker on record, no cap: a token exists, so not a launch to come'],
    ].concat(Object.keys(REASON).filter((k) => a[k]).map((k) => [k, a[k], REASON[k]]));
    return (
      '<div class="checks">' + selfChecks().map((k) => '<span class="check' + (k[0] ? '' : ' bad') + '">' + (k[0] ? '✓ ' : '✗ ') + k[1] + '</span>').join('') + '</div>' +
      '<div class="kpis">' +
      kpi('Ranked', rows.length, 'of ' + c.total + ' read · all ' + n((r) => r.watchlist) + ' on the watchlist, plus ' + n((r) => !r.watchlist) + ' it leaves out') +
      kpi('Implied value', usd(rows.reduce((s, r) => s + r.implied_value_usd, 0)), 'summed over the board · #1 ' + esc(rows[0].name) + ' ' + usd(rows[0].implied_value_usd), 'amber') +
      kpi('Held-out miss', miss(ch.cv.median), 'typical, ' + T.n + ' traded tokens priced blind · one flat multiple misses by ' + miss(T.flat.cv.median)) +
      kpi('Range holds', ch.cv.inBand + ' / ' + ch.cv.n, 'held-out caps inside the stated middle half · older → newer ' + ch.wf.inBand + ' / ' + ch.wf.n) +
      kpi('Worth farming', n((r) => r.plan.verdict === 'farm') + ' farm', n((r) => r.plan.verdict === 'thin') + ' thin · ' + n((r) => r.plan.verdict === 'skip') + ' skip, net of fees against idle cash at ' + M.IDLE_APR * 100 + '%', 'farm') +
      kpi('Best net per hour', signed(best.plan.perHour), esc(best.name) + ' · ' + signed(best.plan.net) + ' on ' + usd(best.plan.deposit) + ' in ' + best.plan.hours.toFixed(1) + ' h') +
      '</div>' +
      '<div class="ledger"><span class="k">' + c.total + ' protocols read, each in exactly one group</span>' +
      '<div class="bar">' + ledger.map((p) => '<i class="' + p[0] + '" style="width:' + ((p[1] / c.total) * 100).toFixed(2) + '%"></i>').join('') + '</div>' +
      '<div class="legend">' + ledger.map((p) => '<span><i class="' + p[0] + '"></i><b>' + p[1] + '</b> ' + p[2] + '</span>').join('') + '</div></div>'
    );
  }

  // ---- Side panel: the test the model had to pass, the fitted formula, and the assumptions ---------

  function evidence() {
    const LABEL = { size: 'Size curve: ln TVL', growth: '+ 7-day TVL growth', age: '+ time with no token', category: '+ category premium' };
    const KEPT = '<span class="mark kept">kept</span>';
    const OUT = '<span class="mark out">not kept</span>';
    const row = (label, t, mark, cls) => '<tr class="' + cls + '"><td>' + label + '</td><td class="num">' + miss(t.cv.median) + '</td><td class="num">' + miss(t.wf.median) + '</td><td>' + mark + '</td></tr>';
    return (
      '<section class="card"><h3>Does it hold on tokens it never saw?</h3>' +
      '<p><code>testModels</code> reprices each of the ' + T.n + ' traded tokens with a fit that never saw it: five folds, and older → newer (the oldest 60% price the newest 40%). The figure is the typical miss: ×2 means half or double the real cap. A term stays only if it cuts the five-fold miss by 1%.</p>' +
      '<table class="test"><thead><tr><th>Term, in order</th><th class="num">5-fold</th><th class="num">old → new</th><th></th></tr></thead><tbody>' +
      row('One flat cap / TVL multiple', T.flat, 'baseline', 'base') +
      T.steps.map((s) => row(LABEL[s.term], s, s.kept ? KEPT : OUT, s.kept ? '' : 'base')).join('') +
      (T.guarded ? row('Range guard on growth and age', T.guarded, T.guard ? KEPT : OUT, T.guard ? 'final' : 'base') : '') +
      '</tbody></table>' +
      '<p>Older → newer is shown, not used to choose: it asks an age term fitted on old listings to price new ones, the reading outside the fitted range that the guard cuts off.</p></section>'
    );
  }

  function formula() {
    const f = model.fit;
    const u = model.use;
    const term = (x) => (x < 0 ? ' − ' : ' + ') + Math.abs(x).toFixed(2);
    if (model.winner === 'F') return '<section class="card"><h3>How a row is priced</h3><p>TVL × the median cap / TVL of the traded tokens (<code>fitFlat</code>): no curve beat it held out.</p></section>';
    return (
      '<section class="card"><h3>How a row is priced</h3>' +
      '<div class="formula">ln value = ' + f.b[0].toFixed(2) + term(f.b[1]) + ' · ln TVL' + (u.growth ? term(f.b[2]) + ' · growth' : '') + (u.age ? term(f.b[3]) + ' · ln(1 + days)' : '') + (u.category ? ' + category premium' : '') + '</div>' +
      '<p><b>growth</b> is the 7-day TVL change as a fraction, <b>days</b> the time tracked with no token. Least squares on the ' + f.n + ' traded tokens’ caps (<code>fitCurve</code>), refitted on every load; no protocol is named anywhere.' +
      (model.guard ? ' Growth is read only between ' + pct(f.gRange[0] * 100) + ' and ' + pct(f.gRange[1] * 100) + ', days between ' + Math.round(Math.exp(f.aRange[0]) - 1) + ' and ' + Math.round(Math.exp(f.aRange[1]) - 1) + ': 90% of the comps sit there.' : '') + '</p>' +
      (u.growth && f.b[2] < 0 ? '<p>The growth coefficient is negative: among these traded tokens, TVL that rose over 7 days went with a lower cap per dollar. It is the fit’s finding, kept because it lowers the held-out miss.</p>' : '') +
      '<p>Middle half: ×' + Math.exp(model.band[0]).toFixed(2) + ' to ×' + Math.exp(model.band[1]).toFixed(2) + ' of the value, the central half of the fit’s own misses (<code>missBand</code>).</p>' +
      scatter(null) +
      '<p class="cap">Grey: real caps of the traded tokens. Amber: implied values on the board. Cap against TVL, log axes.</p></section>'
    );
  }

  function assumptions() {
    return (
      '<section class="card"><h3>What the farm plans assume</h3>' +
      '<p><code>farmPlan</code> sizes the position from TVL, age and drain, and takes fees off its share. Assumptions for budgeting, not snapshot data:</p>' +
      '<ul class="notes"><li><b>' + M.DROP_SHARE * 100 + '%</b> of the implied value reaches depositors, pro rata to TVL (switch it above).</li>' +
      '<li><b>FARM</b> when net of fees beats idle cash at ' + M.IDLE_APR * 100 + '% a year, <b>THIN</b> when positive but below it, <b>SKIP</b> when fees exceed the share.</li>' +
      '<li>Fee per transaction: Ethereum ' + usd(M.chainFee('Ethereum')) + ', Bitcoin ' + usd(M.chainFee('Bitcoin')) + ', Solana ' + usd(M.chainFee('Solana')) + ', other chains ' + usd(M.chainFee('')) + '; trading fee 0.1%.</li></ul></section>'
    );
  }

  /** Market cap against TVL on log axes: the traded comps' real caps and the board's implied values. */
  function scatter(mark) {
    const W = 360;
    const H = 200;
    const L = 34;
    const B = 16;
    const comps = radar.traded.filter((c) => c.mcap_usd);
    const span = (xs) => [Math.log(Math.min.apply(null, xs)), Math.log(Math.max.apply(null, xs))];
    const xr = span(comps.map((c) => c.tvl_usd).concat(rows.map((r) => r.tvl_usd)));
    const yr = span(comps.map((c) => c.mcap_usd).concat(rows.map((r) => r.implied_value_usd)));
    const X = (v) => L + ((Math.log(v) - xr[0]) / (xr[1] - xr[0])) * (W - L - 6);
    const Y = (v) => H - B - ((Math.log(v) - yr[0]) / (yr[1] - yr[0])) * (H - B - 6);
    const dot = (x, y, cls, r) => '<circle class="' + cls + '" cx="' + X(x).toFixed(1) + '" cy="' + Y(y).toFixed(1) + '" r="' + r + '"/>';
    let ticks = '';
    for (let d = 1e3; d <= 1e12; d *= 10) {
      const ln = Math.log(d);
      if (ln >= yr[0] && ln <= yr[1]) ticks += '<line x1="' + L + '" x2="' + W + '" y1="' + Y(d).toFixed(1) + '" y2="' + Y(d).toFixed(1) + '"/><text x="' + (L - 4) + '" y="' + (Y(d) + 3).toFixed(1) + '" text-anchor="end">' + short(d) + '</text>';
      if (ln >= xr[0] && ln <= xr[1]) ticks += '<text x="' + X(d).toFixed(1) + '" y="' + (H - 3) + '" text-anchor="middle">' + short(d) + '</text>';
    }
    return '<svg class="plot" viewBox="0 0 ' + W + ' ' + H + '">' + ticks + comps.map((c) => dot(c.tvl_usd, c.mcap_usd, 'c', 2)).join('') + rows.map((r) => dot(r.tvl_usd, r.implied_value_usd, 'r', 1.6)).join('') + (mark ? dot(mark.tvl_usd, mark.implied_value_usd, 'm', 5) : '') + '</svg>';
  }

  // ---- Board view: tabs, filters, scenario switches, the table and the side panel -----------------

  function board() {
    const view = VIEWS[state.tab];
    const onBoard = state.tab === 'board';
    const t = table(view);
    const n = (fn) => rows.filter(fn).length;
    const seg = (key, options) => '<span class="seg">' + options.map((o) => chip({ [key]: o[0] }, o[1] + (o[2] === undefined ? '' : ' <i>' + o[2] + '</i>'), state[key] === o[0])).join('') + '</span>';
    const options = (values, chosen) => values.map((v) => '<option value="' + esc(v) + '"' + (v === chosen ? ' selected' : '') + '>' + esc(v) + '</option>').join('');
    const categories = Array.from(new Set(view.rows.map((r) => r.category))).sort();
    return (
      '<nav class="tabs">' + Object.keys(VIEWS).map((k) => '<a class="tab' + (k === state.tab ? ' on' : '') + '" href="' + esc(hashFor(Object.assign({}, BLANK, { tab: k, dep: state.dep, share: state.share }))) + '">' + VIEWS[k].label + ' <i>' + VIEWS[k].rows.length + '</i></a>').join('') + '<span class="count">' + t.count + '</span></nav>' +
      '<div class="split"><div>' +
      '<p class="note">' + view.note + '</p>' +
      (onBoard
        ? '<div class="controls">' +
          seg('tier', [['', 'All', rows.length], ['watchlist', 'Watchlist', n((r) => r.watchlist)], ['offlist', 'Off list', n((r) => r.tier === 'offlist')], ['below', 'Below floor', n((r) => r.tier === 'below')]]) +
          seg('verdict', [['', 'Any verdict'], ['farm', 'Farm', n((r) => r.plan.verdict === 'farm')], ['thin', 'Thin', n((r) => r.plan.verdict === 'thin')], ['skip', 'Skip', n((r) => r.plan.verdict === 'skip')]]) +
          '<span class="k">Position</span>' + seg('dep', [['', 'Plan size'], ['1000', '$1,000'], ['10000', '$10,000']]) +
          '</div>'
        : '') +
      '<div class="controls">' +
      (onBoard ? '<span class="k">Drop share</span>' + seg('share', [['2.5', '2.5%'], ['', '5%'], ['10', '10%']]) : '') +
      '<input type="search" id="f-q" placeholder="Search protocol, category or chain" value="' + esc(state.q) + '">' +
      '<select id="f-cat"><option value="">All categories</option>' + options(categories, state.cat) + '</select>' +
      (onBoard ? '<select id="f-conf"><option value="">Any confidence</option>' + options(CONF, state.conf) + '</select>' : '') +
      '<a class="chip solo" href="' + esc(hashFor(Object.assign({}, BLANK, { tab: state.tab }))) + '">Reset</a></div>' +
      t.html +
      '</div><aside class="side">' + evidence() + formula() + assumptions() + '</aside></div>'
    );
  }

  // ---- Detail view: one protocol's valuation, its nearest comps and its farm plan -------------------

  function detail(r) {
    const f = r.farm;
    const p = r.parts;
    const u = model.use;
    const prev = rows[r.rank - 2];
    const next = rows[r.rank];
    const near = radar.traded.filter((c) => c.mcap_usd).sort((x, y) => Math.abs(Math.log(x.tvl_usd / r.tvl_usd)) - Math.abs(Math.log(y.tvl_usd / r.tvl_usd))).slice(0, 5);
    const term = (on, label, x) => '<tr' + (on ? '' : ' class="muted"') + '><td>' + label + '</td><td class="num">' + (on ? '× ' + x.toFixed(2) : 'tested, not kept') + '</td></tr>';
    const fact = (k, v) => '<div><span class="k">' + k + '</span>' + v + '</div>';
    const go = (x, label) => (x ? '<a class="chip solo" href="#/p/' + encodeURIComponent(x.slug) + '">' + label + '</a>' : '');
    const shares = [2.5, 5, 10];
    const whatIf = [500, 1000, 5000].map((d) => '<tr><td>' + usd(d) + '</td>' + shares.map((s) => {
      const x = M.farmPlan(r, radar.as_of, { deposit: d, share: s / 100 });
      return '<td class="num"><span class="' + tone(x.net) + '">' + signed(x.net) + '</span> ' + badge(x.verdict) + '</td>';
    }).join('') + '</tr>').join('');
    return (
      '<article class="detail">' +
      '<header><div><h2><span class="muted">#' + r.rank + '</span> ' + esc(r.name) + '<span class="tag ' + r.tier + '">' + TIER[r.tier] + '</span></h2>' +
      '<p class="muted">' + esc(r.category) + ' · ' + esc(r.chains.join(', ')) + ' · records no token on DefiLlama as of ' + esc(radar.as_of) + '</p></div>' +
      '<div class="controls"><a class="chip solo" href="' + esc(boardHash) + '">← Board</a>' + go(prev, '↑ #' + (r.rank - 1)) + go(next, '↓ #' + (r.rank + 1)) + '</div></header>' +
      '<div class="cols"><div>' +
      '<section class="card"><h3>Implied launch value</h3><p class="big">' + usd(r.implied_value_usd) + '</p>' +
      '<p>Middle half ' + usd(r.range[0]) + ' to ' + usd(r.range[1]) + rangeBar(r) + '</p>' +
      '<table class="test"><tbody>' +
      '<tr><td>TVL ' + usd(r.tvl_usd) + ' on the size curve</td><td class="num">' + usd(p.base) + '</td></tr>' +
      term(u.growth, '7-day TVL change: ' + pct(r.change_7d), p.growth) +
      term(u.age, 'No token for ' + since(r.age_days) + (r.listed_at ? ' (tracked since ' + esc(r.listed_at) + ')' : ''), p.age) +
      term(u.category, 'Category premium: ' + esc(r.category), p.category) +
      '<tr class="final"><td>Implied value</td><td class="num">' + usd(r.implied_value_usd) + '</td></tr>' +
      '</tbody></table>' +
      '<p>Confidence: <span class="conf ' + r.confidence + '">' + r.confidence + '</span>' + (r.notes.length ? '' : ' · every input reported and inside the range of the traded comps') + '</p>' +
      (r.notes.length ? '<ul class="notes">' + r.notes.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') +
      '</section>' +
      '<section class="card"><h3>Closest traded tokens by TVL</h3>' +
      '<p>What the market pays at this size: the five comps nearest in TVL, their real cap and what the curve said blind.</p>' +
      '<table class="test"><thead><tr><th>Token trades</th><th class="num">TVL</th><th class="num">Real cap</th><th class="num">Priced blind</th></tr></thead><tbody>' +
      near.map((c) => '<tr><td>' + esc(c.name) + sub(esc(c.category)) + '</td><td class="num">' + usd(c.tvl_usd) + '</td><td class="num">' + usd(c.mcap_usd) + '</td><td class="num">' + usd(c.blind) + '</td></tr>').join('') +
      '</tbody></table>' + scatter(r) + '<p class="cap">Ring: this protocol. Grey: real caps of traded tokens. Amber: the board.</p></section>' +
      '</div><div>' +
      '<section class="card"><h3>Farm plan · ' + badge(f.verdict) + '</h3>' +
      '<div class="budget">' + fact('Position', usd(f.deposit)) + fact('Weeks', f.weeks) + fact('Fees', usd(f.cost)) + fact('Time', f.hours.toFixed(1) + ' h') + fact('Modelled share', usd(f.drop)) + fact('Net of fees', '<span class="' + tone(f.net) + '">' + signed(f.net) + '</span>') + fact('Net / hour', '<span class="' + tone(f.net) + '">' + signed(f.perHour) + '</span>') + fact('Break-even drop', (f.breakEven * 100).toFixed(1) + '%') + '</div>' +
      '<table class="steps"><thead><tr><th>#</th><th>What to do</th><th>Cost</th><th>Time</th></tr></thead><tbody>' +
      f.steps.map((s, i) => '<tr><td>' + (i + 1) + '</td><td>' + esc(s[0]) + '</td><td>' + esc(s[1]) + '</td><td>' + esc(s[2]) + '</td></tr>').join('') +
      '<tr class="final"><td>' + (f.steps.length + 1) + '</td><td colspan="3">' + esc(f.budget) + '</td></tr>' +
      '</tbody></table></section>' +
      '<section class="card"><h3>What flips the verdict</h3>' +
      '<p>Net of fees at other position sizes and drop shares (<code>farmPlan</code> rerun nine times). It breaks even at a ' + (f.breakEven * 100).toFixed(1) + '% drop share on the plan’s ' + usd(f.deposit) + '.</p>' +
      '<table class="test"><thead><tr><th>Position</th>' + shares.map((s) => '<th class="num">' + s + '% drop share</th>').join('') + '</tr></thead><tbody>' + whatIf + '</tbody></table></section>' +
      '</div></div></article>'
    );
  }

  // ---- Render ----------------------------------------------------------------------------------------

  function render(typing) {
    if (!typing) state = parseHash();
    rows.forEach((r) => {
      r.plan = planOf(r);
    });
    const c = radar.counts;
    const top =
      '<header class="top"><div><h1><a href="#/">Token Launch Radar</a></h1>' +
      '<p>Protocols that record no token on DefiLlama, ranked by what a launch would be worth on their record today, each with a costed plan to farm it.</p></div>' +
      '<p class="meta">snapshot ' + esc(radar.as_of) + ' · ' + c.total + ' protocols read · no network, no list of names<br>An implied value is this model’s claim, not a forecast that a token is issued.</p></header>';
    if (state.slug !== null) {
      const r = bySlug[state.slug];
      app.innerHTML = top + (r ? detail(r) : '<p class="empty">No ranked protocol has the slug “' + esc(state.slug) + '”. <a href="#/">Back to the board</a></p>');
      window.scrollTo(0, 0);
      return;
    }
    boardHash = hashFor(state);
    app.innerHTML = top + proof() + board();
    const box = document.getElementById('f-q');
    box.addEventListener('input', () => {
      state.q = box.value;
      history.replaceState(null, '', hashFor(state));
      render(true);
    });
    if (typing) {
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    }
    ['cat', 'conf'].forEach((k) => {
      const el = document.getElementById('f-' + k);
      if (el) el.addEventListener('change', () => {
        location.hash = hashFor(Object.assign({}, state, { [k]: el.value }));
      });
    });
  }

  window.addEventListener('hashchange', () => render(false));
  render(false);
})();
