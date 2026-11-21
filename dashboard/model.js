/* Token Launch Radar: the model.
   One file, loaded twice: main.ts runs it on Node to write board.json, and the page runs it in the
   browser to explain every row. Nothing here names a protocol: each figure follows from the fields
   the sealed snapshot carries. Implied value = what the traded tokens say a launch at this TVL is
   worth (fitCurve) x how often peers with this record already carry a token (fitOdds). A term stays
   in either fit only if it does better on protocols the fit never saw, in two tests (chooseTerms). */
(function (root) {
  'use strict';

  const DAY_MS = 86400000;
  const FOLDS = 5;          // first test: items sorted by slug, fold = index mod 5 (no randomness)
  const OLDER_SHARE = 0.6;  // second test: fit on the oldest 60% of the dated items, score the newest 40%
  const WIN_MARGIN = 0.95;  // the fitted curve is used only if its held-out miss is 5% under one flat multiple's
  const KEEP_GAIN = 0.99;   // a term stays only if it cuts the held-out score by at least 1% in both tests
  const KEEP_MARGIN = 1.02; // the range guard stays if it costs no more than 2% of held-out miss
  const CAT_SHRINK = 5;     // a category's premium is its summed residual over (its comps + 5)
  const VALUE_TERMS = ['growth', 'age', 'category']; // tried in this order on top of the size curve
  const ODDS_TERMS = ['age', 'size', 'growth'];      // tried in this order on top of the peers' base rate

  // The house rule's visible half: products of a token that already trades are not launches to come.
  const DERIVATIVE_CATEGORIES = ['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX'];
  const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;
  const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
  const VERSION_MARK = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

  const notNull = (x) => x !== null;
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  const bySlug = (p, q) => (p.slug < q.slug ? -1 : p.slug > q.slug ? 1 : 0);
  function quantile(xs, q) {
    const a = xs.slice().sort((x, y) => x - y);
    if (!a.length) return 0;
    const pos = (a.length - 1) * q;
    const lo = Math.floor(pos);
    return a[lo] + (a[Math.ceil(pos)] - a[lo]) * (pos - lo);
  }
  const median = (xs) => quantile(xs, 0.5);

  /** Days a protocol has been tracked as of the snapshot date; null when DefiLlama reports no listing day. */
  function ageDays(asOf, listedAt) {
    if (listedAt === null) return null;
    return Math.max(0, Math.round((Date.parse(asOf + 'T00:00:00Z') - Date.parse(listedAt + 'T00:00:00Z')) / DAY_MS));
  }

  /** 'pre' records no token; 'live' has a CoinGecko id (it trades); 'recorded' carries a ticker only. */
  function tokenState(p) {
    if (p.gecko_id === null && p.symbol === null) return 'pre';
    return p.gecko_id !== null ? 'live' : 'recorded';
  }

  /** Why a pre-token record is still not a launch to come, or null when it stays on the board. */
  function setAsideReason(p) {
    if (DERIVATIVE_CATEGORIES.includes(p.category)) return 'category';
    if (EXCHANGE_PREFIX.test(p.name)) return 'exchange';
    if (WRAPPED_WORD.test(p.name)) return 'wrapped';
    if (VERSION_MARK.test(p.name)) return 'version';
    return null;
  }

  // ---- Baseline: one flat cap/TVL multiple, the median over the traded comps ------------------------

  const fitFlat = (train) => ({ kind: 'F', n: train.length, use: {}, global: median(train.map((p) => p.mcap_usd / p.tvl_usd)) });

  // ---- The fitted curve: ln cap = b0 + b1 ln TVL (+ b2 growth) (+ b3 age) (+ category premium) -----

  /** ln TVL, the 7-day change as a fraction capped at +/-50%, and ln(1 + days with no token); null stays null. */
  function features(p, asOf) {
    const d = ageDays(asOf, p.listed_at);
    return {
      t: Math.log(p.tvl_usd),
      g: p.change_7d === null ? null : clamp(p.change_7d, -50, 50) / 100,
      a: d === null ? null : Math.log(1 + d),
    };
  }

  /** Gaussian elimination with partial pivoting; null when the system is singular. */
  function solve(A, b) {
    const n = b.length;
    const M = A.map((row, i) => row.concat(b[i]));
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      const swap = M[c];
      M[c] = M[piv];
      M[piv] = swap;
      if (Math.abs(M[c][c]) < 1e-12) return null;
      for (let r = c + 1; r < n; r++) {
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let s = M[r][n];
      for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
      x[r] = s / M[r][r];
    }
    return x;
  }

  /** Least squares on the traded comps for the terms named in `use`, then a shrunk premium per category.
      An unreported input reads as the comps' mean, so it moves the value neither way. */
  function fitCurve(train, asOf, use) {
    const feats = train.map((p) => features(p, asOf));
    const gs = feats.map((f) => f.g).filter(notNull);
    const as = feats.map((f) => f.a).filter(notNull);
    const fit = {
      kind: 'B',
      n: train.length,
      use: use,
      cat: {},
      gMean: mean(gs),
      aMean: mean(as),
      // where 90% of the comps sit: beyond these edges the curve has almost no evidence
      gRange: [quantile(gs, 0.05), quantile(gs, 0.95)],
      aRange: [quantile(as, 0.05), quantile(as, 0.95)],
    };
    const X = feats.map((f) => [1, f.t].concat(use.growth ? [f.g === null ? fit.gMean : f.g] : [], use.age ? [f.a === null ? fit.aMean : f.a] : []));
    const y = train.map((p) => Math.log(p.mcap_usd));
    const cols = X[0].map((_, i) => i);
    const XtX = cols.map((i) => cols.map((j) => X.reduce((s, row) => s + row[i] * row[j], 0)));
    const Xty = cols.map((i) => X.reduce((s, row, r) => s + row[i] * y[r], 0));
    const b = solve(XtX, Xty) || cols.map((i) => (i ? 0 : mean(y)));
    fit.b = [b[0], b[1], use.growth ? b[2] : 0, use.age ? b[b.length - 1] : 0];
    if (use.category) {
      const sum = {};
      const count = {};
      train.forEach((p, r) => {
        sum[p.category] = (sum[p.category] || 0) + y[r] - X[r].reduce((s, v, i) => s + v * b[i], 0);
        count[p.category] = (count[p.category] || 0) + 1;
      });
      for (const c of Object.keys(sum).sort()) fit.cat[c] = sum[c] / (count[c] + CAT_SHRINK);
    }
    return fit;
  }

  /** The parts one valuation multiplies: what the TVL alone implies, then growth, age and category.
      With the guard on, growth and age are read no further out than the comps' own 5%..95% range. */
  function valueParts(fit, p, asOf, guard) {
    if (fit.kind === 'F') return { base: p.tvl_usd * fit.global, growth: 1, age: 1, category: 1 };
    const f = features(p, asOf);
    let g = f.g === null ? fit.gMean : f.g;
    let a = f.a === null ? fit.aMean : f.a;
    if (guard) {
      g = clamp(g, fit.gRange[0], fit.gRange[1]);
      a = clamp(a, fit.aRange[0], fit.aRange[1]);
    }
    return {
      base: Math.exp(fit.b[0] + fit.b[1] * f.t + fit.b[2] * fit.gMean + fit.b[3] * fit.aMean),
      growth: Math.exp(fit.b[2] * (g - fit.gMean)),
      age: Math.exp(fit.b[3] * (a - fit.aMean)),
      category: Math.exp(fit.cat[p.category] || 0),
    };
  }

  function predict(fit, p, asOf, guard) {
    const v = valueParts(fit, p, asOf, guard);
    return v.base * v.growth * v.age * v.category;
  }

  /** The middle half of a fit's own misses on the comps it was made from: [25%, 75%] of ln(actual / fitted). */
  function missBand(fit, comps, asOf, guard) {
    const own = comps.map((p) => Math.log(p.mcap_usd / predict(fit, p, asOf, guard)));
    return [quantile(own, 0.25), quantile(own, 0.75)];
  }

  // ---- Token odds: how often peers with this record already carry a token -------------------------

  const oddsRow = (fit, f) => [1].concat(fit.use.age ? [f.a === null ? fit.aMean : f.a] : [], fit.use.size ? [f.t] : [], fit.use.growth ? [f.g === null ? fit.gMean : f.g] : []);

  /** Logistic regression by 25 Newton steps: the share of stand-alone protocols that record a token,
      from the terms named in `use`. With no term it is the peers' base rate. */
  function fitOdds(train, asOf, use) {
    const feats = train.map((p) => features(p, asOf));
    const fit = { use: use, n: train.length, gMean: mean(feats.map((f) => f.g).filter(notNull)), aMean: mean(feats.map((f) => f.a).filter(notNull)) };
    const X = feats.map((f) => oddsRow(fit, f));
    const y = train.map((p) => (tokenState(p) === 'pre' ? 0 : 1));
    fit.b = X[0].map(() => 0);
    for (let step = 0; step < 25; step++) {
      const q = X.map((row) => 1 / (1 + Math.exp(-row.reduce((s, v, i) => s + v * fit.b[i], 0))));
      const H = fit.b.map((_, i) => fit.b.map((_, j) => X.reduce((s, row, r) => s + row[i] * row[j] * q[r] * (1 - q[r]), 0)));
      const d = solve(H, fit.b.map((_, i) => X.reduce((s, row, r) => s + row[i] * (y[r] - q[r]), 0)));
      if (d === null) break;
      fit.b = fit.b.map((v, i) => v + d[i]);
    }
    return fit;
  }

  const oddsOf = (fit, p, asOf) => 1 / (1 + Math.exp(-oddsRow(fit, features(p, asOf)).reduce((s, v, i) => s + v * fit.b[i], 0)));

  // ---- Two held-out tests, shared by both fits -----------------------------------------------------

  /** Five folds by slug order; and older to newer, the oldest 60% of the dated items against the newest 40%. */
  function splits(items) {
    const s = items.slice().sort(bySlug);
    const dated = items.filter((p) => p.listed_at !== null).sort((p, q) => (p.listed_at < q.listed_at ? -1 : p.listed_at > q.listed_at ? 1 : bySlug(p, q)));
    const cut = Math.floor(dated.length * OLDER_SHARE);
    const cv = [];
    for (let k = 0; k < FOLDS; k++) cv.push([s.filter((_, i) => i % FOLDS !== k), s.filter((_, i) => i % FOLDS === k)]);
    return { cv: cv, wf: [[dated.slice(0, cut), dated.slice(cut)]] };
  }

  /** The typical miss of a value fit on caps it never saw: median |ln(actual / predicted)|.
      `inBand` counts the held-out caps inside the band the fit states from its own comps. */
  function valueTest(pairs, asOf, use, guard) {
    const miss = [];
    const out = { inBand: 0, blind: {} };
    for (const [train, test] of pairs) {
      const fit = use ? fitCurve(train, asOf, use) : fitFlat(train);
      const band = missBand(fit, train, asOf, guard);
      for (const p of test) {
        const guess = predict(fit, p, asOf, guard);
        const m = Math.log(p.mcap_usd / guess);
        miss.push(Math.abs(m));
        out.blind[p.slug] = guess;
        if (m >= band[0] && m <= band[1]) out.inBand++;
      }
    }
    out.n = miss.length;
    out.score = median(miss);
    return out;
  }

  /** The Brier score of an odds fit on peers it never saw, and how many it called right. */
  function oddsTest(pairs, asOf, use) {
    const out = { n: 0, right: 0, score: 0 };
    for (const [train, test] of pairs) {
      const fit = fitOdds(train, asOf, use);
      for (const p of test) {
        const y = tokenState(p) === 'pre' ? 0 : 1;
        const q = oddsOf(fit, p, asOf);
        out.score += (q - y) * (q - y);
        out.n++;
        if (q >= 0.5 === (y === 1)) out.right++;
      }
    }
    out.score /= out.n;
    return out;
  }

  /** Terms are added one at a time; one stays only if it lowers the held-out score by 1% in both tests. */
  function chooseTerms(terms, test) {
    const out = { use: {}, best: test({}), steps: [] };
    out.steps.push(Object.assign({ term: 'start', kept: true }, out.best));
    for (const term of terms) {
      const use = Object.assign({}, out.use);
      use[term] = true;
      const t = test(use);
      const kept = t.cv.score <= KEEP_GAIN * out.best.cv.score && t.wf.score <= KEEP_GAIN * out.best.wf.score;
      out.steps.push(Object.assign({ term: term, kept: kept }, t));
      if (kept) {
        out.use = use;
        out.best = t;
      }
    }
    return out;
  }

  /** Everything the model has to prove, rerun on every load: both fits term by term, and the range guard. */
  function testModels(comps, peers, asOf) {
    const c = splits(comps);
    const p = splits(peers);
    const value = (use, guard) => ({ cv: valueTest(c.cv, asOf, use, guard), wf: valueTest(c.wf, asOf, use, guard) });
    const out = {
      n: comps.length,
      peers: peers.length,
      flat: value(null),
      value: chooseTerms(VALUE_TERMS, value),
      odds: chooseTerms(ODDS_TERMS, (use) => ({ cv: oddsTest(p.cv, asOf, use), wf: oddsTest(p.wf, asOf, use) })),
    };
    const v = out.value;
    out.guarded = v.use.growth || v.use.age ? value(v.use, true) : null;
    out.guard = out.guarded !== null && out.guarded.cv.score <= KEEP_MARGIN * v.best.cv.score;
    out.winner = v.best.cv.score <= WIN_MARGIN * out.flat.cv.score ? 'B' : 'F';
    out.chosen = out.winner === 'F' ? out.flat : out.guard ? out.guarded : v.best;
    return out;
  }

  // ---- Families: a product whose sibling already records a token is not a launch to come ---------

  const FAMILY_MAX_FALSE = 1; // the sibling rule is used only if it wrongly flags at most 1 watchlist protocol
  const familyStem = (slug) => slug.split('-')[0];

  function familyIndex(protocols) {
    const index = {};
    for (const p of protocols) {
      const stem = familyStem(p.slug);
      if (stem.length >= 3) (index[stem] = index[stem] || []).push(p);
    }
    return index;
  }

  /** Slugs of siblings (same first slug word) that already record a token. */
  function tokenKin(index, p) {
    return (index[familyStem(p.slug)] || []).filter((q) => q.slug !== p.slug && tokenState(q) !== 'pre').map((q) => q.slug);
  }

  /** What is unreported or outside the comps' range for one protocol; each note costs a confidence step. */
  function inputNotes(fit, oddsFit, p, asOf, guard) {
    const notes = [];
    const f = features(p, asOf);
    const use = fit.use;
    const odds = oddsFit ? oddsFit.use : {};
    const outside = (v, range) => range !== undefined && (v < range[0] || v > range[1]);
    const edge = guard ? 'read at the edge of that range' : 'the curve is read beyond it';
    if ((use.growth || odds.growth) && f.g === null) notes.push('7-day TVL change unreported: read as the mean');
    else if (use.growth && outside(f.g, fit.gRange)) notes.push('7-day TVL change outside the range of the traded comps: ' + edge);
    if ((use.age || odds.age) && f.a === null) notes.push('listing date unknown: no-token time read as the mean');
    else if (use.age && outside(f.a, fit.aRange)) notes.push('no-token time outside the range of the traded comps: ' + edge);
    if (use.category && !(p.category in fit.cat)) notes.push('no traded comp in this category: no category premium applied');
    return notes;
  }

  // ---- Farm plan: sized, costed and netted from the row's own numbers -----------------------------

  const DROP_SHARE = 0.05; // assumption: the share of the launch value that reaches depositors, pro rata to TVL
  const IDLE_APR = 0.05;   // the bar a farm has to clear: what the same dollars earn in a year doing nothing

  const ARCHETYPE = {
    lend: ['Lending', 'Uncollateralized Lending', 'Collateral Markets', 'CDP Manager'],
    mint: ['CDP'],
    trade: ['Dexs', 'Derivatives', 'Prediction Market', 'OTC Marketplace', 'Interest Rate Derivatives'],
    dollar: ['RWA', 'Basis Trading', 'Dual-Token Stablecoin', 'Stablecoin Wrapper', 'Anchor BTC', 'Decentralized BTC', 'Payments', 'Crypto Card Issuer'],
    chain: ['Chain'],
  };

  /** How a category is farmed: lend, mint, trade, hold its dollar or BTC asset, use the chain, or deposit in a vault. */
  function archetype(category) {
    for (const kind of Object.keys(ARCHETYPE)) if (ARCHETYPE[kind].includes(category)) return kind;
    return 'vault';
  }

  /** A typical fee per transaction in USD: an estimate for budgeting, not snapshot data. */
  function chainFee(chain) {
    if (chain === 'Ethereum') return 4;
    if (chain === 'Bitcoin') return 2;
    if (chain === 'Solana') return 0.01;
    return 0.1;
  }

  function usd(n) {
    const a = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    if (a >= 1e9) return sign + '$' + (a / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return sign + '$' + (a / 1e6).toFixed(1) + 'M';
    if (a >= 100) return sign + '$' + String(Math.round(a)).replace(/\B(?=(\d{3})+$)/g, ',');
    return sign + '$' + (Number.isInteger(a) ? String(a) : a.toFixed(2));
  }

  /** The plan for one board row: position size from TVL, age and drain; weeks from age; fees from the
      chain; and the position's modelled share of the launch, net of those fees. `opt` lets the page
      rerun it at another position size or drop share; board.json carries the plan with no `opt`. */
  function farmPlan(r, asOf, opt) {
    const o = opt || {};
    const share = o.share || DROP_SHARE;
    // The plan starts on the first chain DefiLlama lists for the protocol; the snapshot does not say which chain holds most TVL.
    const chain = r.chains.length ? r.chains[0] : 'its home chain';
    const fee = chainFee(chain);
    const kind = archetype(r.category);
    const draining = r.change_7d !== null && r.change_7d <= -15;
    let deposit = r.tvl_usd >= 1e9 ? 2500 : r.tvl_usd >= 1e8 ? 1000 : 500;
    if (draining) deposit /= 2;
    if (r.age_days !== null && r.age_days < 90) deposit = Math.min(deposit, 500);
    if (o.deposit) deposit = o.deposit;
    const weeks = r.age_days === null ? 12 : r.age_days < 180 ? 8 : r.age_days < 730 ? 12 : 16;
    const entry = chain === 'Ethereum' ? 5 : 2;
    const weeklyVolume = deposit / 4;
    const tradeFees = kind === 'trade' ? weeks * weeklyVolume * 0.001 : 0;
    const cost = entry + fee * (5 + weeks) + tradeFees;
    const hours = (20 + 15 + 10 + 5 * weeks + 10 * Math.ceil(weeks / 4) + 10) / 60;
    const pool = (r.implied_value_usd * deposit) / r.tvl_usd; // this position's pro-rata slice of the whole implied value
    const drop = pool * share;
    const net = drop - cost;
    const bar = (deposit * IDLE_APR * weeks) / 52;
    const verdict = net >= bar ? 'farm' : net > 0 ? 'thin' : 'skip';
    const name = r.name;
    const core = {
      vault: 'Deposit ' + usd(deposit) + ' of USDC or ETH into ' + name + "'s largest vault by deposits; skip looped or leveraged strategies, which can be liquidated.",
      lend: 'Supply ' + usd(deposit) + ' of ETH or a stablecoin on ' + name + ', then borrow a stablecoin worth ' + usd(deposit / 4) + ' against it (25% loan-to-value) so both sides of the market record your address.',
      mint: 'Open a vault on ' + name + ', lock ' + usd(deposit) + ' of its accepted collateral and mint ' + usd(deposit / 4) + ' of its stablecoin: a 400% collateral ratio, far from liquidation.',
      trade: 'Split ' + usd(deposit) + ' on ' + name + ': half as liquidity or margin in its deepest market, half kept liquid for trading.',
      dollar: 'Mint or buy ' + usd(deposit) + ' of ' + name + "'s own asset in its official app; if the issuer asks for KYC, finish it first (allow 1 to 3 days).",
      chain: 'Bridge ' + usd(deposit) + ' to ' + name + ' through its canonical bridge and split it across its two largest native apps (one swap venue, one lending market).',
    }[kind];
    const depth = {
      vault: 'Hold the position untouched: vault programmes usually weigh balance multiplied by time, so one deposit held ' + weeks + ' weeks counts for more than several rotated.',
      lend: 'Repay and re-borrow once a month to refresh activity, keeping the loan under 30% of collateral so a 40% price drop cannot liquidate it.',
      trade: 'Trade about ' + usd(weeklyVolume) + ' of volume a week in the most liquid pair, split over 2 or 3 days; at a 0.1% fee that is about ' + usd(weeklyVolume * 0.001) + ' a week on top of network fees.',
      dollar: "Hold the asset in your own wallet or in the issuer's own savings module, if it has one: issuers usually count holding time, and parking it in another protocol can drop you from their records.",
      chain: 'Touch at least three different contracts over the period (a swap, a loan, one native app): chains usually score distinct contracts and active weeks, not size.',
    }[kind === 'mint' ? 'lend' : kind];
    const second = r.chains.length > 1 ? ' ' + name + ' also runs on ' + r.chains[1] + ': a quarter-size second position there is a separate deployment and costs about ' + usd(entry + 3 * chainFee(r.chains[1])) + ' more.' : '';
    const change = r.change_7d === null ? '7-day change unreported' : (r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(1) + '% over 7 days';
    const verdictText = {
      farm: 'FARM: net of fees it beats the ' + usd(bar) + ' the same dollars would earn idle at ' + IDLE_APR * 100 + '% a year.',
      thin: 'THIN: positive after fees, but less than the ' + usd(bar) + ' the same dollars would earn idle at ' + IDLE_APR * 100 + '% a year.',
      skip: 'SKIP at this size: fees exceed the modelled share.',
    }[verdict];
    // Each step: what to do, what it costs, how long it takes.
    const steps = [
      ['Fund a fresh wallet on ' + chain + ' with ' + usd(deposit) + ' plus ' + usd(Math.max(1, Math.ceil(fee * (5 + weeks)))) + ' for fees, by exchange withdrawal or a bridge.', 'about ' + usd(entry), '20 minutes'],
      [core, 'about ' + usd(2 * fee) + ' in network fees (approve, then deposit)', '15 minutes'],
      [depth + second, 'about ' + usd(fee) + ' per transaction', '10 minutes'],
      ['Return once a week for ' + weeks + ' weeks and make one small on-chain action (add, claim, compound or adjust) so every week shows activity.', 'about ' + usd(fee * weeks) + ' in total', '5 minutes a week'],
      ['Once a month, open ' + name + "'s app and look for a points, season or referral page; screenshot your totals and log every transaction hash in one sheet.", '$0', '10 minutes a month'],
      ['Exit rule: TVL was ' + usd(r.tvl_usd) + ' on ' + asOf + ' (' + change + ')' + (draining && !o.deposit ? ', already draining, so the position is half-size' : '') + '. Withdraw in full if TVL falls 30% below that, if withdrawals are paused, or at week ' + weeks + ' with no token or points programme announced.', 'about ' + usd(2 * fee), '10 minutes'],
    ];
    const budget = 'Budget: ' + usd(cost) + ' in fees and about ' + hours.toFixed(1) + ' hours over ' + weeks + ' weeks on a ' + usd(deposit) + ' position. If ' + share * 100 + '% of the ' + usd(r.implied_value_usd) + ' implied launch value reached depositors pro rata to TVL, this position would receive about ' + usd(drop) + ', or ' + usd(net) + ' net of fees. ' + verdictText;
    return {
      kind: kind,
      chain: chain,
      deposit: deposit,
      weeks: weeks,
      cost: cost,
      hours: hours,
      drop: drop,
      net: net,
      perHour: net / hours,
      breakEven: cost / pool, // the drop share at which this position only pays back its fees
      bar: bar,
      verdict: verdict,
      steps: steps,
      budget: budget,
      lines: steps.map((s) => s[0] + ' Cost: ' + s[1] + '. Time: ' + s[2] + '.').concat(budget), // board.json's farm_steps
    };
  }

  // ---- The whole radar: every protocol in the snapshot is ranked, set aside or counted as trading ---

  function buildRadar(snapshot) {
    const asOf = snapshot.as_of;
    const watch = new Set(snapshot.watchlist);
    const index = familyIndex(snapshot.protocols);
    // The sibling rule is tested on the watchlist, which the house built from protocols with no parent.
    const falseKin = snapshot.protocols.filter((p) => watch.has(p.slug) && tokenKin(index, p).length > 0).map((p) => p.slug);
    const familyTrusted = falseKin.length <= FAMILY_MAX_FALSE;

    const counts = { total: snapshot.protocols.length, live: 0, recorded: 0, pre: 0, ranked: 0, unscored: 0, aside: { category: 0, exchange: 0, wrapped: 0, version: 0, family: 0 } };
    const category = (p) => (p.category === null ? 'Uncategorized' : p.category);
    const aside = [];
    const tokens = [];
    const board = [];
    const peers = [];
    // First pass: each protocol goes to exactly one group, from the snapshot's facts alone.
    for (const p of snapshot.protocols) {
      const state = tokenState(p);
      if (state !== 'pre') {
        counts[state]++;
        tokens.push(p);
        if (setAsideReason(p) === null) peers.push(p); // stands alone and records a token
        continue;
      }
      counts.pre++;
      const kin = tokenKin(index, p);
      let reason = watch.has(p.slug) ? null : setAsideReason(p);
      if (reason === null && !watch.has(p.slug) && familyTrusted && kin.length > 0) reason = 'family';
      if (reason !== null) {
        counts.aside[reason]++;
        aside.push({ slug: p.slug, name: p.name, category: category(p), tvl_usd: p.tvl_usd, reason: reason, kin: kin });
        continue;
      }
      board.push(p);
      peers.push(p); // stands alone and records none
    }

    // Second pass: fit and test on the traded comps and on the peers, then price the board.
    const comps = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0);
    const test = testModels(comps, peers, asOf);
    const use = test.winner === 'F' ? {} : test.value.use;
    const guard = test.winner === 'B' && test.guard;
    const fit = test.winner === 'F' ? fitFlat(comps) : fitCurve(comps, asOf, use);
    const band = missBand(fit, comps, asOf, guard);
    // Odds are used only if a term beat the peers' base rate held out: one factor on every row ranks nothing.
    const oddsFit = Object.keys(test.odds.use).length ? fitOdds(peers, asOf, test.odds.use) : null;
    const rows = [];
    for (const p of board) {
      const onWatch = watch.has(p.slug);
      const parts = valueParts(fit, p, asOf, guard);
      const launch = parts.base * parts.growth * parts.age * parts.category;
      const odds = oddsFit ? oddsOf(oddsFit, p, asOf) : 1;
      const implied = Math.round(launch * odds);
      if (!Number.isFinite(implied) || implied < 1) {
        counts.unscored++; // no value is invented: a row that cannot be priced stays off the board
        continue;
      }
      const notes = inputNotes(fit, oddsFit, p, asOf, guard);
      // The house kept every parentless protocol above its floor on the watchlist, so one above the
      // floor that passes the visible rules yet is not listed must have a parent DefiLlama records.
      const parentInferred = !onWatch && p.tvl_usd >= snapshot.floor_usd;
      if (parentInferred) notes.push('above the floor yet off the watchlist: DefiLlama records a parent protocol for it (inferred)');
      rows.push({
        slug: p.slug,
        name: p.name,
        category: category(p),
        chains: p.chains,
        tvl_usd: p.tvl_usd,
        change_7d: p.change_7d,
        listed_at: p.listed_at,
        age_days: ageDays(asOf, p.listed_at),
        watchlist: onWatch,
        tier: onWatch ? 'watchlist' : parentInferred ? 'offlist' : 'below',
        if_launched: Math.round(launch),
        odds: odds,
        implied_value_usd: implied,
        range: [Math.max(1, Math.round(implied * Math.exp(band[0]))), Math.round(implied * Math.exp(band[1]))],
        parts: parts,
        notes: notes,
        confidence: ['high', 'medium', 'low'][Math.min(2, notes.length)],
      });
    }
    rows.sort((x, y) => y.implied_value_usd - x.implied_value_usd || y.tvl_usd - x.tvl_usd || bySlug(x, y));
    // Where a row would rank at either edge of its middle half, every other row unmoved.
    const above = (v) => rows.filter((x) => x.implied_value_usd > v).length;
    rows.forEach((r, i) => {
      r.rank = i + 1;
      r.rank_range = [Math.min(r.rank, 1 + above(r.range[1])), Math.max(r.rank, above(r.range[0]))];
      r.farm = farmPlan(r, asOf);
    });
    counts.ranked = rows.length;
    return {
      as_of: asOf,
      source: snapshot.source,
      floor_usd: snapshot.floor_usd,
      counts: counts,
      model: { winner: test.winner, guard: guard, use: use, test: test, fit: fit, oddsFit: oddsFit, band: band, comps: comps.length },
      family: { trusted: familyTrusted, false_on_watchlist: falseKin },
      rows: rows,
      aside: aside,
      // A token on record is never ranked; `blind` is what a fit that never saw the comp priced it at.
      tokens: tokens.map((p) => ({ slug: p.slug, name: p.name, category: category(p), tvl_usd: p.tvl_usd, symbol: p.symbol, mcap_usd: p.mcap_usd > 0 ? p.mcap_usd : null, blind: test.chosen.cv.blind[p.slug] || null })),
    };
  }

  root.RadarModel = { DROP_SHARE: DROP_SHARE, IDLE_APR: IDLE_APR, chainFee: chainFee, usd: usd, farmPlan: farmPlan, buildRadar: buildRadar };
})(globalThis);
