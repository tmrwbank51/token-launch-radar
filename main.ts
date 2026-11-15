// Token Launch Radar (v3): build the board, the dashboard data and the
// dossier from the sealed snapshot. Node 22, standard library only, no
// network, no clock, no randomness: the same snapshot always produces the
// same bytes. The dashboard itself re-implements the model in the page
// (dashboard/app.js), so the dossier carries both the submitted board and
// the live code that re-derives it. See lib/model.ts for the model.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBoard } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const REPO_ROOT = fileURLToPath(new URL('.', import.meta.url));

function flagValue(argv, flag) {
  const at = argv.indexOf(flag);
  if (at >= 0) {
    if (!argv[at + 1]) throw new Error(`${flag} needs a value`);
    return argv[at + 1];
  }
  const prefixed = argv.find((a) => a.startsWith(`${flag}=`));
  return prefixed ? prefixed.slice(flag.length + 1) : null;
}

function validateSnapshot(snapshot) {
  const problems = [];
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new Error('Invalid snapshot: the snapshot must be a JSON object');
  }
  if (typeof snapshot.as_of !== 'string') problems.push('as_of must be a string');
  if (typeof snapshot.floor_usd !== 'number') problems.push('floor_usd must be a number');
  if (!Array.isArray(snapshot.protocols)) problems.push('protocols must be an array');
  if (!Array.isArray(snapshot.watchlist)) problems.push('watchlist must be an array');
  for (const [index, protocol] of (snapshot.protocols ?? []).entries()) {
    for (const field of ['slug', 'name', 'chains', 'tvl_usd', 'change_7d', 'mcap_usd', 'listed_at', 'gecko_id', 'symbol']) {
      if (!(field in protocol)) problems.push(`protocol ${index} is missing ${field}`);
    }
    if (typeof protocol.tvl_usd !== 'number' || protocol.tvl_usd < 0) problems.push(`protocol ${index} has an invalid tvl_usd`);
    if (!Array.isArray(protocol.chains)) problems.push(`protocol ${index} has chains that are not an array`);
  }
  if (problems.length) throw new Error(`Invalid snapshot: ${problems.join('; ')}`);
}

function main() {
  const argv = process.argv.slice(2);
  const inputPath = flagValue(argv, '--input') ?? '/input/snapshot.json';
  const outDir = flagValue(argv, '--output') ?? process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  if (resolve(outDir) === resolve(REPO_ROOT)) {
    throw new Error('Refusing to write the output into the repository root.');
  }
  if (!existsSync(inputPath)) throw new Error(`snapshot not found: ${inputPath}`);
  const snapshot = JSON.parse(readFileSync(inputPath, 'utf8'));
  validateSnapshot(snapshot);
  const board = buildBoard(snapshot);

  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(outDir, 'screenshots'), { recursive: true });
  cpSync(join(REPO_ROOT, 'dashboard'), join(outDir, 'dashboard'), { recursive: true });
  cpSync(join(REPO_ROOT, 'screenshots'), join(outDir, 'screenshots'), { recursive: true });
  writeFileSync(
    join(outDir, 'board.json'),
    `${JSON.stringify({ as_of: snapshot.as_of, floor_usd: snapshot.floor_usd, rows: board.rows }, null, 2)}\n`,
  );
  // The page loads this beside the dashboard and runs with no network, so
  // it is the page's only data: the submitted rows with their breakdowns,
  // signals, reasoning and costed plans; the calibration table with its
  // quartiles; the live-token set the page uses for nearestComparables;
  // and the board's own aggregates for the charts and the memo.
  writeFileSync(
    join(outDir, 'data.js'),
    `window.RADAR_DATA = ${JSON.stringify({ as_of: snapshot.as_of, floor_usd: snapshot.floor_usd, rows: board.rows, calibration: board.calibration, stats: board.stats })};\n`,
  );
  writeFileSync(join(outDir, 'dossier.json'), buildDossier(outDir, { text_max_bytes: 65536 }));
}

main();
