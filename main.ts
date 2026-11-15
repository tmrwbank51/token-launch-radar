// Token Launch Radar entrypoint (v2): read the sealed snapshot, build the
// ranked board, write the dashboard's data, copy the dashboard and the
// screenshots, and write the dossier with make.fun's dossier library.
//
// The grader runs this twice in a fresh no-network container and requires
// identical bytes both times, so the run only reads, computes, and writes:
// no clock, no randomness, no network. The input is /input/snapshot.json in
// the sandbox; --input overrides it for local runs. The dashboard's data
// file sits beside the page (data.js), the board sits in board.json, and
// dossier.json is exactly what buildDossier writes from dashboard/ and
// screenshots/, so the gate's dossier row compares equal.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';
import { buildBoard } from './lib/model.ts';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Refuse to run when the output directory is the repository itself, so a
// misconfigured run can never overwrite the sources it copies from.
if (resolve(outDir) === resolve(repoRoot)) {
  throw new Error('MAKEFUN_OUTPUT_DIR must not be the repository itself');
}

function snapshotPathFrom(argv) {
  const flagAt = argv.indexOf('--input');
  if (flagAt >= 0 && !argv[flagAt + 1]) {
    throw new Error('--input needs a path to snapshot.json');
  }
  return flagAt >= 0 ? argv[flagAt + 1] : '/input/snapshot.json';
}

const inputPath = snapshotPathFrom(process.argv.slice(2));
if (!existsSync(inputPath)) {
  throw new Error(`snapshot not found: ${inputPath}`);
}

const snapshot = JSON.parse(readFileSync(inputPath, 'utf8'));
if (
  typeof snapshot.as_of !== 'string' ||
  typeof snapshot.floor_usd !== 'number' ||
  !Array.isArray(snapshot.protocols) ||
  !Array.isArray(snapshot.watchlist)
) {
  throw new Error('snapshot.json is not the sealed snapshot: as_of, floor_usd, protocols and watchlist are required');
}
const { rows, calibration, stats } = buildBoard(snapshot);

mkdirSync(outDir, { recursive: true });
mkdirSync(join(outDir, 'screenshots'), { recursive: true });
cpSync(join(repoRoot, 'dashboard'), join(outDir, 'dashboard'), { recursive: true });
cpSync(join(repoRoot, 'screenshots'), join(outDir, 'screenshots'), { recursive: true });

writeFileSync(
  join(outDir, 'board.json'),
  `${JSON.stringify({ as_of: stats.as_of, floor_usd: stats.floor_usd, rows }, null, 2)}\n`,
);

// Everything the page renders, in one object: the rows with their value
// breakdowns, signals, reasoning and farm plans, the calibration table with
// its quartiles, and the board's own aggregates. The page runs with no
// network, so this file is its only data.
const dashboardData = {
  as_of: stats.as_of,
  floor_usd: stats.floor_usd,
  protocols: stats.protocols,
  pre_token: stats.pre_token,
  board_rows: stats.board_rows,
  watchlist: stats.watchlist,
  watchlist_covered: stats.watchlist_covered,
  board_tvl_usd: stats.board_tvl_usd,
  categories: stats.categories,
  global_multiple: calibration.globalMultiple,
  global_q1: calibration.globalQ1,
  global_q3: calibration.globalQ3,
  calibration_live: calibration.liveCount,
  calibration: calibration.table,
  rows,
};
writeFileSync(join(outDir, 'data.js'), `window.RADAR_DATA = ${JSON.stringify(dashboardData)};\n`);

writeFileSync(join(outDir, 'dossier.json'), buildDossier(outDir, { text_max_bytes: 65536 }));
