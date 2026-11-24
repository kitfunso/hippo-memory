#!/usr/bin/env node
// README.md's "Public memory tests" table, built from the data the home page's table reads, so the two cannot drift.
// `node website/scripts/readme-public-tests.mjs --write` rewrites it; check-readme-sync.mjs fails the build while it is stale.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const START = '<!-- public-tests:start: website/scripts/readme-public-tests.mjs writes this table -->';
export const END = '<!-- public-tests:end -->';

const cell = (text) => String(text).replace(/\|/g, '\\|');
const bold = (text, best) => (best ? `**${cell(text)}**` : cell(text));

/** The home table's rows, columns and best-score marks (src/pages/index.astro), as one markdown table. */
export function renderPublicTests(board) {
  const cols = board.homeColumns;
  const lines = [START, `| Benchmarks (official setup) | hippo | ${cols.join(' | ')} | Others |`,
    `|---|${'--:|'.repeat(cols.length + 1)}---|`];
  for (const r of [...board.official, ...board.published]) {
    const top = Math.max(r.hippo.num ?? -Infinity, ...r.rivals.map((x) => x.num));
    const hippo = r.hippo.status ? `*${cell(r.hippo.status)}*` : bold(r.hippo.value, r.hippo.num === top);
    const named = cols.map((c) => {
      const x = r.rivals.find((y) => y.name === c);
      if (!x) return '-';
      return bold(x.value, x.num === top) + (x.system && x.system !== c ? ` ${cell(x.system)}` : '');
    });
    const rest = r.rivals.filter((x) => !cols.includes(x.name)).sort((a, b) => b.num - a.num);
    const others = rest.length
      ? `${bold(rest[0].value, rest[0].num === top)} ${cell(rest[0].system ?? rest[0].name)}${rest.length > 1 ? ` +${rest.length - 1}` : ''}`
      : '-';
    lines.push(`| ${cell(r.name)} | ${hippo} | ${named.join(' | ')} | ${others} |`);
  }
  lines.push(END);
  return lines.join('\n');
}

/** README text with the table between the markers replaced; throws when the markers are missing. */
export function withPublicTests(readme, board) {
  const a = readme.indexOf(START);
  const b = readme.indexOf(END);
  if (a < 0 || b < a) throw new Error(`README.md has no "${START}" ... "${END}" block under "### Public memory tests"`);
  return readme.slice(0, a) + renderPublicTests(board) + readme.slice(b + END.length);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const path = join(root, '..', 'README.md');
  const board = JSON.parse(await readFile(join(root, 'src', 'data', 'all-benchmarks.json'), 'utf8'));
  const readme = (await readFile(path, 'utf8')).replace(/\r\n/g, '\n');
  const next = withPublicTests(readme, board);
  if (!process.argv.includes('--write')) {
    console.log(next === readme ? 'README public tests table is current' : 'README public tests table is stale: rerun with --write');
    process.exit(next === readme ? 0 : 1);
  }
  await writeFile(path, next);
  console.log(`wrote the public tests table: ${board.official.length + board.published.length} rows`);
}
