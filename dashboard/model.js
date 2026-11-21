/* Token Launch Radar: the model.
   One file, loaded twice: main.ts runs it on Node to write board.json, and the page runs it in the
   browser to explain every row. Nothing here names a protocol: each figure follows from the ten
   fields the sealed snapshot carries (TVL, 7-day TVL change, listing date, category, chains, and
   whether a token is recorded). */
(function (root) {
  'use strict';

  const DAY_MS = 86400000;
  const FOLDS = 5;          // held-out test: comps sorted by slug, fold = index mod 5 (no randomness)
  const MIN_COMPS = 5;      // a category needs this many traded comps to get its own multiple
  const WIN_MARGIN = 0.95;  // the fitted curve replaces the multiples only if its held-out error is 5% lower
  const KEEP_MARGIN = 1.02; // the shrunk curve replaces the raw fit if its held-out error is no more than 2% higher

  // The house rule's visible half: products of a token that already trades are not launches to come.
  const DERIVATIVE_CATEGORIES = ['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX'];
  const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;
  const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
  const VERSION_MARK = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

  const notNull = (x) => x !== null;
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  function median(xs) {
    const a = xs.slice().sort((x, y) => x - y);
    const n = a.length;
    if (!n) return NaN;
    return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
  }

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

  // ---- Model A: category multiples with hand-set growth and age factors -------------------------

  const growthFactor = (g) => (g === null ? 1 : 1 + 0.5 * Math.tanh(g / 25));
  const ageFactor = (d) => 0.55 + 0.45 * Math.min(1, d / 365);

  function fitMultiples(train, asOf) {
    const byCat = {};
    const ratios = train.map((p) => p.mcap_usd / p.tvl_usd);
    train.forEach((p, i) => {
      (byCat[p.category] = byCat[p.category] || []).push(ratios[i]);
    });
    const cat = {};
    for (const c of Object.keys(byCat).sort()) cat[c] = { n: byCat[c].length, median: median(byCat[c]) };
    const ages = train.map((p) => ageDays(asOf, p.listed_at)).filter(notNull);
    return { kind: 'A', n: train.length, global: median(ratios), cat: cat, medAge: ages.length ? median(ages) : 365 };
  }

  function multipleFor(fit, category) {
    const c = fit.cat[category];
    return c && c.n >= MIN_COMPS ? c.median : fit.global;
  }

  function predictMultiples(fit, p, asOf) {
    const d = ageDays(asOf, p.listed_at);
    return p.tvl_usd * multipleFor(fit, p.category) * growthFactor(p.change_7d) * ageFactor(d === null ? fit.medAge : d);
  }

  // ---- Model B: log-linear curve fitted to the traded comps by least squares ---------------------

  /** ln TVL, the 7-day change as a fraction capped at +/-50%, and ln(1 + age in days); null stays null. */
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

  function fitLogLinear(train, asOf) {
    const feats = train.map((p) => features(p, asOf));
    const gMean = mean(feats.map((f) => f.g).filter(notNull));
    const aMean = mean(feats.map((f) => f.a).filter(notNull));
    const X = feats.map((f) => [1, f.t, f.g === null ? gMean : f.g, f.a === null ? aMean : f.a]);
    const y = train.map((p) => Math.log(p.mcap_usd));
    const XtX = [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => X.reduce((s, row) => s + row[i] * row[j], 0)));
    const Xty = [0, 1, 2, 3].map((i) => X.reduce((s, row, r) => s + row[i] * y[r], 0));
    const b = solve(XtX, Xty) || [mean(y), 0, 0, 0];
    const gs = feats.map((f) => f.g).filter(notNull);
    const as = feats.map((f) => f.a).filter(notNull);
    return {
      kind: 'B',
      n: train.length,
      b: b,
      gMean: gMean,
      aMean: aMean,
      sd: residualSd(X, y, b),
      // where 90% of the comps sit: beyond these edges the curve has almost no evidence
      gRange: [quantile(gs, 0.05), quantile(gs, 0.95)],
      aRange: [quantile(as, 0.05), quantile(as, 0.95)],
    };
  }

  function residualSd(X, y, b) {
    const sq = X.reduce((s, row, r) => {
      const e = y[r] - row.reduce((t, v, i) => t + v * b[i], 0);
      return s + e * e;
    }, 0);
    return Math.sqrt(sq / Math.max(1, y.length - b.length));
  }

  /** What the curve reads for one protocol. An unreported input reads as the comps' mean; with the
      guard on, growth and age are read no further out than the comps' own 5%..95% range. */
  function curveInputs(fit, p, asOf, guard) {
    const f = features(p, asOf);
    let g = f.g === null ? fit.gMean : f.g;
    let a = f.a === null ? fit.aMean : f.a;
    if (guard) {
      g = clamp(g, fit.gRange[0], fit.gRange[1]);
      a = clamp(a, fit.aRange[0], fit.aRange[1]);
    }
    return { t: f.t, g: g, a: a };
  }

  function predictLogLinear(fit, p, asOf, guard) {
    const x = curveInputs(fit, p, asOf, guard);
    return Math.exp(fit.b[0] + fit.b[1] * x.t + fit.b[2] * x.g + fit.b[3] * x.a);
  }

  // ---- Model C: the same curve, kept inside the comps' own range and shrunk ----------------------

  const SHRINKS = [0, 0.1, 0.3, 1, 3, 10]; // ridge penalty on the growth and age terms, as a multiple of the comp count

  function quantile(xs, q) {
    const a = xs.slice().sort((x, y) => x - y);
    if (!a.length) return 0;
    const pos = (a.length - 1) * q;
    const lo = Math.floor(pos);
    return a[lo] + (a[Math.ceil(pos)] - a[lo]) * (pos - lo);
  }

  /** How one input is read: cut to the comps' own 5%..95% range, then centred and scaled. */
  function scaler(values) {
    const lo = quantile(values, 0.05);
    const hi = quantile(values, 0.95);
    const cut = values.map((v) => clamp(v, lo, hi));
    const m = mean(cut);
    const sd = Math.sqrt(mean(cut.map((v) => (v - m) * (v - m)))) || 1;
    return { lo: lo, hi: hi, mean: m, sd: sd };
  }

  /** An unreported input reads as 0, the comps' mean: it moves the value neither way. */
  const scaled = (s, v) => (v === null ? 0 : (clamp(v, s.lo, s.hi) - s.mean) / s.sd);

  /** ln TVL, the 7-day TVL change as a fraction, and ln(1 + days tracked); null stays null. */
  function inputs(p, asOf) {
    const d = ageDays(asOf, p.listed_at);
    return { t: Math.log(p.tvl_usd), g: p.change_7d === null ? null : p.change_7d / 100, a: d === null ? null : Math.log(1 + d) };
  }

  /** ln mcap = b0 + b1 (ln TVL - mean) + b2 z(growth) + b3 z(age), with b2 and b3 shrunk toward 0. */
  function fitCurve(train, asOf, shrink) {
    const ins = train.map((p) => inputs(p, asOf));
    const tMean = mean(ins.map((f) => f.t));
    const g = scaler(ins.map((f) => f.g).filter(notNull));
    const a = scaler(ins.map((f) => f.a).filter(notNull));
    const X = ins.map((f) => [1, f.t - tMean, scaled(g, f.g), scaled(a, f.a)]);
    const y = train.map((p) => Math.log(p.mcap_usd));
    const XtX = [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => X.reduce((s, row) => s + row[i] * row[j], 0)));
    const Xty = [0, 1, 2, 3].map((i) => X.reduce((s, row, r) => s + row[i] * y[r], 0));
    XtX[2][2] += shrink * train.length;
    XtX[3][3] += shrink * train.length;
    const b = solve(XtX, Xty) || [mean(y), 0, 0, 0];
    return { kind: 'C', n: train.length, shrink: shrink, b: b, tMean: tMean, g: g, a: a, sd: residualSd(X, y, b) };
  }

  /** The three parts one valuation multiplies: what the TVL alone implies, then growth, then age. */
  function curveTerms(fit, p, asOf) {
    const f = inputs(p, asOf);
    return {
      base: Math.exp(fit.b[0] + fit.b[1] * (f.t - fit.tMean)),
      growth: Math.exp(fit.b[2] * scaled(fit.g, f.g)),
      age: Math.exp(fit.b[3] * scaled(fit.a, f.a)),
    };
  }

  function predictCurve(fit, p, asOf) {
    const t = curveTerms(fit, p, asOf);
    return t.base * t.growth * t.age;
  }

  // ---- Held-out test: which model prices the traded comps better when it has not seen them -------

  function ranks(xs) {
    const order = xs.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]);
    const out = new Array(xs.length);
    for (let i = 0; i < order.length; ) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
      for (let k = i; k <= j; k++) out[order[k][1]] = (i + j) / 2 + 1;
      i = j + 1;
    }
    return out;
  }

  function spearman(xs, ys) {
    const rx = ranks(xs);
    const ry = ranks(ys);
    const mx = mean(rx);
    const my = mean(ry);
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < rx.length; i++) {
      sxy += (rx[i] - mx) * (ry[i] - my);
      sxx += (rx[i] - mx) * (rx[i] - mx);
      syy += (ry[i] - my) * (ry[i] - my);
    }
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
  }

  /** Every comp is priced once by a model that never saw it; the error is |ln predicted - ln actual|. */
  function heldOut(comps, asOf, fitFn, predictFn) {
    const sorted = comps.slice().sort((p, q) => (p.slug < q.slug ? -1 : p.slug > q.slug ? 1 : 0));
    const err = [];
    const pred = [];
    const actual = [];
    const folds = [];
    for (let k = 0; k < FOLDS; k++) {
      const fit = fitFn(sorted.filter((_, i) => i % FOLDS !== k), asOf);
      const e = [];
      for (const p of sorted.filter((_, i) => i % FOLDS === k)) {
        const guess = predictFn(fit, p, asOf);
        e.push(Math.abs(Math.log(guess) - Math.log(p.mcap_usd)));
        pred.push(guess);
        actual.push(p.mcap_usd);
      }
      folds.push({ n: e.length, median: median(e) });
      for (const d of e) err.push(d);
    }
    return { n: sorted.length, median: median(err), mean: mean(err), spearman: spearman(pred, actual), folds: folds };
  }

  /** The whole test: A against B, then the shrunk curve C at each strength, and the model the rules pick. */
  function crossValidate(comps, asOf) {
    const out = {
      n: comps.length,
      naive: heldOut(comps, asOf, fitMultiples, (fit, p) => p.tvl_usd * fit.global),
      A: heldOut(comps, asOf, fitMultiples, predictMultiples),
      B: heldOut(comps, asOf, fitLogLinear, predictLogLinear),
      grid: SHRINKS.map((s) => Object.assign({ shrink: s }, heldOut(comps, asOf, (train) => fitCurve(train, asOf, s), predictCurve))),
    };
    // The strongest shrink whose held-out error is within 1% of the best: when in doubt, trust the terms less.
    const best = Math.min.apply(null, out.grid.map((g) => g.median));
    out.C = out.grid.filter((g) => g.median <= best * 1.01).pop();
    out.shrink = out.C.shrink;
    // B replaces A only if it is 5% better; C replaces B if it is no more than 2% worse.
    out.winner = out.B.median <= WIN_MARGIN * out.A.median ? (out.C.median <= KEEP_MARGIN * out.B.median ? 'C' : 'B') : 'A';
    // The guard (no reading beyond the comps' range) is kept if it costs no more than 2% of held-out error.
    out.G = heldOut(comps, asOf, fitLogLinear, (fit, p, when) => predictLogLinear(fit, p, when, true));
    out.guard = out.G.median <= KEEP_MARGIN * out.B.median;
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

  // ---- Valuation of one protocol ------------------------------------------------------------------

  /** What the TVL alone implies, then the growth and age multipliers, under whichever model won. */
  function valueParts(fit, p, asOf, guard) {
    if (fit.kind === 'A') {
      const d = ageDays(asOf, p.listed_at);
      return { base: p.tvl_usd * multipleFor(fit, p.category), growth: growthFactor(p.change_7d), age: ageFactor(d === null ? fit.medAge : d) };
    }
    if (fit.kind === 'C') return curveTerms(fit, p, asOf);
    const x = curveInputs(fit, p, asOf, guard);
    return {
      base: Math.exp(fit.b[0] + fit.b[1] * x.t + fit.b[2] * fit.gMean + fit.b[3] * fit.aMean),
      growth: Math.exp(fit.b[2] * (x.g - fit.gMean)),
      age: Math.exp(fit.b[3] * (x.a - fit.aMean)),
    };
  }

  /** What is unreported or outside the comps' range for one protocol; each note costs a confidence step. */
  function inputNotes(fit, p, asOf) {
    const notes = [];
    const f = features(p, asOf);
    const outside = (v, range) => range !== undefined && (v < range[0] || v > range[1]);
    if (f.g === null) notes.push('7-day TVL change unreported: growth term left neutral');
    else if (outside(f.g, fit.gRange)) notes.push('7-day TVL change outside the range of the traded comps: read at the edge of that range');
    if (f.a === null) notes.push('listing date unknown: age term left neutral');
    else if (outside(f.a, fit.aRange)) notes.push('age outside the range of the traded comps: read at the edge of that range');
    return notes;
  }

  // ---- Farm plan: sized, costed and netted from the row's own numbers -----------------------------

  const DROP_SHARE = 0.05; // assumption: the share of the launch value that reaches depositors, pro rata to TVL
  const IDLE_APR = 0.05;   // the bar a farm has to clear: what the same dollars earn in a year doing nothing

  const ARCHETYPE = {
    lend: ['Lending', 'Uncollateralized Lending', 'Collateral Markets', 'CDP', 'CDP Manager'],
    trade: ['Dexs', 'Derivatives', 'Prediction Market', 'OTC Marketplace', 'Interest Rate Derivatives'],
    dollar: ['RWA', 'Basis Trading', 'Dual-Token Stablecoin', 'Stablecoin Wrapper', 'Anchor BTC', 'Decentralized BTC', 'Payments', 'Crypto Card Issuer'],
    chain: ['Chain'],
  };

  /** How a category is farmed: lend, trade, hold its dollar or BTC asset, use the chain, or deposit in a vault. */
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
      chain; and the position's modelled share of the launch, net of those fees. */
  function farmPlan(r, asOf) {
    const chain = r.chains.length ? r.chains[0] : 'its home chain';
    const fee = chainFee(chain);
    const kind = archetype(r.category);
    const draining = r.change_7d !== null && r.change_7d <= -15;
    let deposit = r.tvl_usd >= 1e9 ? 2500 : r.tvl_usd >= 1e8 ? 1000 : 500;
    if (draining) deposit /= 2;
    if (r.age_days !== null && r.age_days < 90) deposit = Math.min(deposit, 500);
    const weeks = r.age_days === null ? 12 : r.age_days < 180 ? 8 : r.age_days < 730 ? 12 : 16;
    const entry = chain === 'Ethereum' ? 5 : 2;
    const weeklyVolume = deposit / 4;
    const tradeFees = kind === 'trade' ? weeks * weeklyVolume * 0.001 : 0;
    const cost = entry + fee * (5 + weeks) + tradeFees;
    const hours = (20 + 15 + 10 + 5 * weeks + 10 * Math.ceil(weeks / 4) + 10) / 60;
    const drop = (r.implied_value_usd * DROP_SHARE * deposit) / r.tvl_usd;
    const net = drop - cost;
    const bar = (deposit * IDLE_APR * weeks) / 52;
    const verdict = net >= bar ? 'farm' : net > 0 ? 'thin' : 'skip';
    const name = r.name;
    const core = {
      vault: 'Deposit ' + usd(deposit) + ' of USDC or ETH into ' + name + "'s largest vault by deposits; skip looped or leveraged strategies, which can be liquidated.",
      lend: 'Supply ' + usd(deposit) + ' of ETH or a stablecoin on ' + name + ', then borrow a stablecoin worth ' + usd(deposit / 4) + ' against it (25% loan-to-value) so both sides of the market record your address.',
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
    }[kind];
    const second = r.chains.length > 1 ? ' ' + name + ' also runs on ' + r.chains[1] + ': a quarter-size second position there is a separate deployment and costs about ' + usd(entry + 3 * chainFee(r.chains[1])) + ' more.' : '';
    const change = r.change_7d === null ? '7-day change unreported' : (r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(1) + '% over 7 days';
    const verdictText = {
      farm: 'FARM: net of fees it beats the ' + usd(bar) + ' the same dollars would earn idle at ' + IDLE_APR * 100 + '% a year.',
      thin: 'THIN: positive after fees, but less than the ' + usd(bar) + ' the same dollars would earn idle at ' + IDLE_APR * 100 + '% a year.',
      skip: 'SKIP at this size: fees exceed the modelled share.',
    }[verdict];
    const steps = [
      'Fund a fresh wallet on ' + chain + ' with ' + usd(deposit) + ' plus ' + usd(Math.max(1, Math.ceil(fee * (5 + weeks)))) + ' for fees, by exchange withdrawal or a bridge. Cost: about ' + usd(entry) + '. Time: 20 minutes.',
      core + ' Cost: about ' + usd(2 * fee) + ' in network fees (approve, then deposit). Time: 15 minutes.',
      depth + second + ' Cost: about ' + usd(fee) + ' per transaction. Time: 10 minutes.',
      'Return once a week for ' + weeks + ' weeks and make one small on-chain action (add, claim, compound or adjust) so every week shows activity. Cost: about ' + usd(fee * weeks) + ' in total. Time: 5 minutes a week.',
      'Once a month, open ' + name + "'s app and look for a points, season or referral page; screenshot your totals and log every transaction hash in one sheet. Cost: $0. Time: 10 minutes a month.",
      'Exit rule: TVL was ' + usd(r.tvl_usd) + ' on ' + asOf + ' (' + change + ')' + (draining ? ', already draining, so the position is half-size' : '') + '. Withdraw in full if TVL falls 30% below that, if withdrawals are paused, or at week ' + weeks + ' with no token or points programme announced. Cost: about ' + usd(2 * fee) + '. Time: 10 minutes.',
      'Budget: ' + usd(cost) + ' in fees and about ' + hours.toFixed(1) + ' hours over ' + weeks + ' weeks on a ' + usd(deposit) + ' position. If ' + DROP_SHARE * 100 + '% of the ' + usd(r.implied_value_usd) + ' implied launch value reached depositors pro rata to TVL, this position would receive about ' + usd(drop) + ', or ' + usd(net) + ' net of fees. ' + verdictText,
    ];
    return { kind: kind, chain: chain, deposit: deposit, weeks: weeks, cost: cost, hours: hours, drop: drop, net: net, bar: bar, verdict: verdict, steps: steps };
  }

  // ---- The whole radar: every protocol in the snapshot is ranked, set aside or counted as trading ---

  function buildRadar(snapshot) {
    const asOf = snapshot.as_of;
    const watch = new Set(snapshot.watchlist);
    const index = familyIndex(snapshot.protocols);
    const comps = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0);
    const cv = crossValidate(comps, asOf);
    const fit = cv.winner === 'A' ? fitMultiples(comps, asOf) : cv.winner === 'C' ? fitCurve(comps, asOf, cv.shrink) : fitLogLinear(comps, asOf);

    // The sibling rule is tested on the watchlist, which the house built from protocols with no parent.
    const falseKin = snapshot.protocols.filter((p) => watch.has(p.slug) && tokenKin(index, p).length > 0).map((p) => p.slug);
    const familyTrusted = falseKin.length <= FAMILY_MAX_FALSE;

    const counts = { total: snapshot.protocols.length, live: 0, recorded: 0, pre: 0, ranked: 0, unscored: 0, aside: { category: 0, exchange: 0, wrapped: 0, version: 0, family: 0 } };
    const rows = [];
    const aside = [];
    for (const p of snapshot.protocols) {
      const state = tokenState(p);
      if (state !== 'pre') {
        counts[state]++;
        continue;
      }
      counts.pre++;
      const onWatch = watch.has(p.slug);
      const kin = tokenKin(index, p);
      let reason = onWatch ? null : setAsideReason(p);
      if (reason === null && !onWatch && familyTrusted && kin.length > 0) reason = 'family';
      if (reason !== null) {
        counts.aside[reason]++;
        aside.push({ slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, reason: reason, kin: kin });
        continue;
      }
      const parts = valueParts(fit, p, asOf, cv.guard);
      const implied = Math.round(parts.base * parts.growth * parts.age);
      if (!Number.isFinite(implied) || implied < 1) {
        counts.unscored++; // no value is invented: a row that cannot be priced stays off the board
        continue;
      }
      const notes = inputNotes(fit, p, asOf);
      // The house kept every parentless protocol above its floor on the watchlist, so one above the
      // floor that passes the visible rules yet is not listed must have a parent DefiLlama records.
      const parentInferred = !onWatch && p.tvl_usd >= snapshot.floor_usd;
      if (parentInferred) notes.push('above the floor yet off the watchlist: DefiLlama records a parent protocol for it (inferred)');
      rows.push({
        slug: p.slug,
        name: p.name,
        category: p.category === null ? 'Uncategorized' : p.category,
        chains: p.chains,
        tvl_usd: p.tvl_usd,
        change_7d: p.change_7d,
        listed_at: p.listed_at,
        age_days: ageDays(asOf, p.listed_at),
        watchlist: onWatch,
        parent_inferred: parentInferred,
        implied_value_usd: implied,
        parts: parts,
        notes: notes,
        confidence: ['high', 'medium', 'low'][Math.min(2, notes.length)],
      });
    }
    rows.sort((x, y) => y.implied_value_usd - x.implied_value_usd || y.tvl_usd - x.tvl_usd || (x.slug < y.slug ? -1 : 1));
    rows.forEach((r, i) => {
      r.rank = i + 1;
      r.farm = farmPlan(r, asOf);
    });
    counts.ranked = rows.length;
    return {
      as_of: asOf,
      source: snapshot.source,
      floor_usd: snapshot.floor_usd,
      counts: counts,
      model: { winner: cv.winner, guard: cv.guard, cv: cv, fit: fit, comps: comps.length },
      family: { trusted: familyTrusted, false_on_watchlist: falseKin },
      rows: rows,
      aside: aside,
    };
  }

  root.RadarModel = {
    tokenKin: tokenKin,
    familyIndex: familyIndex,
    valueParts: valueParts,
    inputNotes: inputNotes,
    archetype: archetype,
    chainFee: chainFee,
    usd: usd,
    DROP_SHARE: DROP_SHARE,
    IDLE_APR: IDLE_APR,
    farmPlan: farmPlan,
    buildRadar: buildRadar,
    FOLDS: FOLDS,
    MIN_COMPS: MIN_COMPS,
    WIN_MARGIN: WIN_MARGIN,
    median: median,
    ageDays: ageDays,
    tokenState: tokenState,
    setAsideReason: setAsideReason,
    growthFactor: growthFactor,
    ageFactor: ageFactor,
    fitMultiples: fitMultiples,
    multipleFor: multipleFor,
    predictMultiples: predictMultiples,
    features: features,
    fitLogLinear: fitLogLinear,
    curveInputs: curveInputs,
    predictLogLinear: predictLogLinear,
    SHRINKS: SHRINKS,
    KEEP_MARGIN: KEEP_MARGIN,
    scaled: scaled,
    inputs: inputs,
    fitCurve: fitCurve,
    curveTerms: curveTerms,
    predictCurve: predictCurve,
    heldOut: heldOut,
    crossValidate: crossValidate,
  };
})(globalThis);
