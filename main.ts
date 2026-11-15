// Token Launch Radar entrypoint: read the sealed snapshot, build the ranked
// board, write the dashboard's data, copy the dashboard and screenshots, and
// write the dossier with make.fun's dossier library.
//
// The grader runs this twice in a fresh no-network container and requires
// identical bytes both times, so it only reads, computes, and writes: no
// timestamps, no randomness, no network. The input is /input/snapshot.json
// in the sandbox; --input overrides it for local runs.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';
import { buildBoard } from './lib/model.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Refuse to run when the output directory is the repository itself, so a
// misconfigured run can never overwrite the sources it copies from.
if (resolve(out) === resolve(here)) {
  throw new Error('MAKEFUN_OUTPUT_DIR must not be the repository itself');
}

const args = process.argv.slice(2);
const inputFlag = args.indexOf('--input');
if (inputFlag >= 0 && !args[inputFlag + 1]) {
  throw new Error('--input needs a path to snapshot.json');
}
const inputPath = inputFlag >= 0 ? args[inputFlag + 1] : '/input/snapshot.json';
if (!existsSync(inputPath)) {
  throw new Error(`snapshot not found: ${inputPath}`);
}

const snapshot = JSON.parse(readFileSync(inputPath, 'utf8'));
if (typeof snapshot.as_of !== 'string' || !Array.isArray(snapshot.protocols) || !Array.isArray(snapshot.watchlist)) {
  throw new Error('snapshot.json is not the sealed snapshot: as_of, protocols and watchlist are required');
}
const { rows, calibration, stats } = buildBoard(snapshot);

mkdirSync(out, { recursive: true });
mkdirSync(join(out, 'screenshots'), { recursive: true });
cpSync(join(here, 'dashboard'), join(out, 'dashboard'), { recursive: true });
cpSync(join(here, 'screenshots'), join(out, 'screenshots'), { recursive: true });

writeFileSync(join(out, 'board.json'), `${JSON.stringify({ as_of: stats.as_of, floor_usd: stats.floor_usd, rows }, null, 2)}\n`);

const dashboardData = {
  as_of: stats.as_of,
  floor_usd: stats.floor_usd,
  protocols: stats.protocols,
  pre_token: stats.pre_token,
  board_rows: stats.board_rows,
  watchlist: stats.watchlist,
  watchlist_covered: stats.watchlist_covered,
  board_tvl_usd: stats.board_tvl_usd,
  global_multiple: calibration.globalMultiple,
  calibration: calibration.table,
  rows,
};
writeFileSync(join(out, 'data.js'), `window.RADAR_DATA = ${JSON.stringify(dashboardData)};\n`);

writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: 65536 }));
