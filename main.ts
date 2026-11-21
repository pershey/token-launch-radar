// Token Launch Radar, an entry for make.fun's token-radar-01. Node 22, standard library only, no network.
//
// It reads the sealed snapshot, runs the model in dashboard/model.js (the very file the page loads, so
// the board and the screen cannot drift apart) and writes into the output directory:
//
//   board.json    the ranked board the gate reads
//   data.js       the snapshot and each row's value, for the page to recompute and compare
//   dashboard/    this repository's static page, copied as it is
//   screenshots/  the three captures, copied as they are
//   dossier.json  what the judge reads, written last by vendor/makefun-board.ts
//
// Nothing is invented on the way: a row that cannot be priced is left off the board and counted, and a
// board the gate would refuse stops the run with exit code 1 instead of being patched.
//
// Outside the grader:
//   MAKEFUN_OUTPUT_DIR=out node main.ts --input ../token-radar-01-kit/input/snapshot.json

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import './dashboard/model.js';
import { buildDossier } from './vendor/makefun-board.ts';

type Protocol = {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
};
type Snapshot = { as_of: string; source: string; floor_usd: number; protocols: Protocol[]; watchlist: string[] };
type BoardRow = {
  rank: number;
  slug: string;
  name: string;
  implied_value_usd: number;
  farm_steps: string[];
  category: string;
  tvl_usd: number;
  watchlist: boolean;
  confidence: string;
  verdict: string;
};

const model = (globalThis as any).RadarModel;
const here = dirname(fileURLToPath(import.meta.url));

function stop(message: string): never {
  process.stderr.write(`token-launch-radar: ${message}\n`);
  process.exit(1);
}

/** `--name value` or `--name=value` from the command line, else the fallback. */
function option(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const at = args.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < args.length) return args[at + 1] as string;
  const joined = args.find((a) => a.startsWith(`--${name}=`));
  return joined === undefined ? fallback : joined.slice(name.length + 3);
}

function readSnapshot(path: string): Snapshot {
  if (!existsSync(path)) stop(`no snapshot at ${path}; pass --input <snapshot.json or its directory>`);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Snapshot;
  const shaped =
    typeof raw.as_of === 'string' &&
    typeof raw.floor_usd === 'number' &&
    Array.isArray(raw.watchlist) &&
    Array.isArray(raw.protocols) &&
    raw.protocols.every((p) => typeof p.slug === 'string' && typeof p.name === 'string' && Array.isArray(p.chains) && Number.isFinite(p.tvl_usd) && p.tvl_usd > 0);
  if (!shaped) stop(`${path} is not a token-radar snapshot (as_of, floor_usd, protocols with a TVL, watchlist)`);
  return raw;
}

/** The gate's rules for board.json, checked here first; every breach is listed, none is repaired. */
function gateIssues(rows: BoardRow[], snapshot: Snapshot): string[] {
  const issues: string[] = [];
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  if (rows.length < 100 || rows.length > 4000) issues.push(`${rows.length} rows; the gate takes 100 to 4,000`);
  rows.forEach((r, i) => {
    if (!known.has(r.slug)) issues.push(`row ${i + 1}: ${r.slug} is not one of the snapshot's protocols`);
    if (seen.has(r.slug)) issues.push(`row ${i + 1}: ${r.slug} appears twice`);
    seen.add(r.slug);
    if (r.name.trim() === '') issues.push(`${r.slug}: empty name`);
    if (r.rank !== i + 1) issues.push(`${r.slug}: rank ${r.rank} where ${i + 1} is due`);
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd < 1 || r.implied_value_usd > 1e14) issues.push(`${r.slug}: implied value ${r.implied_value_usd} is not a positive whole number of dollars`);
    if (i > 0 && r.implied_value_usd > (rows[i - 1] as BoardRow).implied_value_usd) issues.push(`${r.slug}: implied value rises against its rank`);
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) issues.push(`${r.slug}: ${r.farm_steps.length} farm steps; the gate takes 3 to 12`);
    r.farm_steps.forEach((s, n) => {
      const length = s.trim().length;
      if (length < 20 || length > 600) issues.push(`${r.slug}: farm step ${n + 1} is ${length} characters; the gate takes 20 to 600`);
    });
  });
  if (rows.length > 1 && rows.every((r) => r.implied_value_usd === (rows[0] as BoardRow).implied_value_usd)) issues.push('every implied value is the same: the board ranks nothing');
  const missing = snapshot.watchlist.filter((slug) => !seen.has(slug));
  if (missing.length > 0) issues.push(`watchlist not covered: ${missing.join(', ')}`);
  return issues;
}

/** Copy the regular files of one flat directory, skipping dot-files; returns the names copied. */
function copyFlat(from: string, to: string): string[] {
  mkdirSync(to, { recursive: true });
  if (!existsSync(from)) return [];
  const names = readdirSync(from)
    .filter((name) => !name.startsWith('.') && statSync(join(from, name)).isFile())
    .sort();
  for (const name of names) copyFileSync(join(from, name), join(to, name));
  return names;
}

const input = option('input', '/input');
const snapshot = readSnapshot(input.endsWith('.json') ? input : join(input, 'snapshot.json'));
const out = option('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const radar = model.buildRadar(snapshot);
const rows: BoardRow[] = radar.rows.map((r: any) => ({
  rank: r.rank,
  slug: r.slug,
  name: r.name,
  implied_value_usd: r.implied_value_usd,
  farm_steps: r.farm.steps,
  category: r.category,
  tvl_usd: r.tvl_usd,
  watchlist: r.watchlist,
  confidence: r.confidence,
  verdict: r.farm.verdict,
}));

const issues = gateIssues(rows, snapshot);
if (issues.length > 0) stop(`the board would fail the gate, so nothing was written:\n  ${issues.slice(0, 20).join('\n  ')}`);

const cv = radar.model.cv;
const board = {
  as_of: radar.as_of,
  source: radar.source,
  floor_usd: radar.floor_usd,
  model: {
    chosen: radar.model.winner,
    guard: radar.model.guard,
    comps: radar.model.comps,
    held_out_median_abs_log_error: { multiples: cv.A.median, fitted_curve: cv.B.median, fitted_curve_guarded: cv.G.median, tvl_only_multiple: cv.naive.median },
    drop_share_assumed: model.DROP_SHARE,
  },
  counts: radar.counts,
  rows: rows,
};

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify(board)}\n`);

const values: Record<string, number> = {};
for (const r of rows) values[r.slug] = r.implied_value_usd;
writeFileSync(join(out, 'data.js'), `window.RADAR_SNAPSHOT = ${JSON.stringify(snapshot)};\nwindow.RADAR_BOARD = ${JSON.stringify(values)};\n`);

cpSync(join(here, 'dashboard'), join(out, 'dashboard'), { recursive: true });
const shots = copyFlat(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) stop(`board.json, data.js and dashboard/ are written, but screenshots/ holds ${shots.length} image(s): the dossier needs 3 (board, detail, filtered view)`);

// Last, because the scorer rebuilds the dossier from this very directory and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: 65536, screenshots: { max: 4, max_bytes: 524288 }, dashboard: { max_files: 400, max_bytes: 4194304 } }));

const c = radar.counts;
process.stdout.write(
  `token-launch-radar: ${c.total} protocols: ${c.ranked} ranked, ${c.pre - c.ranked - c.unscored} set aside, ${c.unscored} unpriced, ${c.live} trading, ${c.recorded} with a ticker only\n` +
    `token-launch-radar: model ${radar.model.winner}${radar.model.guard ? ' with the range guard' : ''}; watchlist ${snapshot.watchlist.length}/${snapshot.watchlist.length} covered; wrote ${out}\n`,
);
