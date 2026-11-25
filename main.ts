// Token launch radar: entrypoint (Node 22, standard library only).
//
// Reads the sealed DefiLlama snapshot, ranks the pre-token protocols by
// the fitted category model (see lib/model.ts), and writes:
//   <out>/board.json      the ranked board (rows 1..N)
//   <out>/dashboard/      the page (index.html, app.css, app.js) + data.js
//   <out>/screenshots/    the three screenshots
//   <out>/dossier.json    buildDossier from vendor/makefun-board.ts
//
// Usage: MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
// Defaults: input /input/snapshot.json, output $MAKEFUN_OUTPUT_DIR or /output.
// Deterministic: two runs write byte-identical output. No clock, no network,
// no randomness; every ordering is fixed by the snapshot's own order.

import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, parseSnapshot, type RadarData } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const root = dirname(fileURLToPath(import.meta.url));

/**
 * The dashboard's data: the radar's rows without the fields the page never
 * renders, so the whole dashboard stays under the dossier's 64 KiB text cap.
 * mcap_usd is null for every pre-token row and listed_at is not shown; only
 * the main chain is shown (it is the chain the farm plan uses). board.json
 * keeps the complete rows.
 */
function dashboardData(radar: RadarData): string {
  const rows = radar.rows.map((r) => ({
    rank: r.rank,
    slug: r.slug,
    name: r.name,
    category: r.category,
    chains: r.chains.slice(0, 1),
    tvl_usd: r.tvl_usd,
    change_7d: r.change_7d,
    implied_value_usd: r.implied_value_usd,
    category_multiple: r.category_multiple,
    growth_multiplier: r.growth_multiplier,
  }));
  return `window.RADAR=${JSON.stringify({ ...radar, rows })};\n`;
}

function flagValue(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
}

function main(): void {
  const argv = process.argv.slice(2);
  const input = flagValue(argv, '--input') ?? process.env.SNAPSHOT_PATH ?? '/input/snapshot.json';
  const outDir = resolve(process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

  const snapshot = parseSnapshot(readFileSync(resolve(input), 'utf8'));
  const { board, radar } = buildRadar(snapshot);
  const issue = boardIssue(board, snapshot);
  if (issue !== null) throw new Error(`board refused: ${issue}`);

  // Clear the output directory's contents, not the directory itself: in the
  // grader /output is a mounted volume, and removing a mount point fails
  // with EBUSY. The grader always starts with an empty /output; this keeps
  // local re-runs deterministic too.
  mkdirSync(outDir, { recursive: true });
  for (const name of readdirSync(outDir)) {
    rmSync(join(outDir, name), { recursive: true, force: true });
  }
  mkdirSync(join(outDir, 'dashboard'), { recursive: true });
  mkdirSync(join(outDir, 'screenshots'), { recursive: true });

  writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board }, null, 2)}\n`, 'utf8');
  cpSync(join(root, 'dashboard'), join(outDir, 'dashboard'), { recursive: true });
  writeFileSync(join(outDir, 'dashboard', 'data.js'), dashboardData(radar), 'utf8');
  cpSync(join(root, 'screenshots'), join(outDir, 'screenshots'), { recursive: true });

  const dossier = buildDossier(outDir, { text_max_bytes: 65536 });
  writeFileSync(join(outDir, 'dossier.json'), dossier);

  const top = board[0]!;
  console.log(
    `board: ${board.length} rows, watchlist ${snapshot.watchlist.length} covered, ` +
      `top ${top.slug} $${top.implied_value_usd}, dossier ${dossier.length} bytes`,
  );
}

main();
