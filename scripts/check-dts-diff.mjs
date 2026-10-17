#!/usr/bin/env node
// Writes (--write) or verifies (--check) api/hippo-memory.api.txt: one sorted line per exported name and declaration kind
// of every published entry under dist. A PR that changes the public API must change the report in the same diff.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stripComments } from './lib/source-text.mjs';

const DECLARATION =
  /^export\s+(?:declare\s+)?(?:abstract\s+)?(const\s+enum|const|let|var|function|class|interface|type|enum|namespace)\s+([\w$]+)/gm;
const NAMED_LIST = /^export\s+(?:type\s+)?\{([^}]*)\}/gm;
const STAR = /^export\s+(?:type\s+)?\*(?:\s+as\s+([\w$]+))?\s+from\s+['"]([^'"]+)['"]/gm;
const DEFAULT = /^export\s+default\b/m;

/** Rows `name kind` a d.ts text exports; only column-0 `export` lines count, so a namespace's members stay out. */
function exportedRows(text) {
  const src = stripComments(text);
  const rows = [];
  for (const m of src.matchAll(DECLARATION)) rows.push(`${m[2]} ${m[1].replace(/\s+/g, ' ')}`);
  for (const m of src.matchAll(NAMED_LIST)) {
    for (const item of m[1].split(',')) {
      const name = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop();
      if (name) rows.push(`${name} re-export`);
    }
  }
  for (const m of src.matchAll(STAR)) rows.push(m[1] ? `${m[1]} namespace-re-export` : `* from '${m[2]}' star-re-export`);
  if (DEFAULT.test(src)) rows.push('default default');
  return rows;
}

/** The published entry declarations: dist/index.d.ts, dist/server.d.ts and dist/entry/*.d.ts. */
function entryFiles(root) {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .map((p) => p.replace(/\\/g, '/'))
    .filter((p) => p === 'index.d.ts' || p === 'server.d.ts' || /^entry\/[^/]+\.d\.ts$/.test(p))
    .sort();
}

function buildReport(root) {
  const lines = entryFiles(root).flatMap((file) =>
    exportedRows(readFileSync(join(root, file), 'utf8')).map((row) => `${file}: ${row}`),
  );
  return [...new Set(lines)].sort().join('\n') + '\n';
}

/** Lines only in `was` get `-`, lines only in `now` get `+`. */
function diffReports(was, now) {
  const a = new Set(was.split('\n').filter(Boolean));
  const b = new Set(now.split('\n').filter(Boolean));
  return [...[...a].filter((l) => !b.has(l)).sort().map((l) => `- ${l}`), ...[...b].filter((l) => !a.has(l)).sort().map((l) => `+ ${l}`)];
}

function parseArgs(argv) {
  const args = { mode: null, dist: 'dist', report: 'api/hippo-memory.api.txt' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--write' || argv[i] === '--check') args.mode = argv[i].slice(2);
    else if (argv[i] === '--dist') args.dist = argv[++i];
    else if (argv[i] === '--report') args.report = argv[++i];
    else return null;
  }
  return args.mode && args.dist && args.report ? args : null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error('usage: node scripts/check-dts-diff.mjs --write|--check [--dist <dir>] [--report <file>]');
    return 2;
  }
  if (!existsSync(args.dist)) {
    console.error(`check-dts-diff: ${args.dist} does not exist; run npm run build first`);
    return 2;
  }
  const now = buildReport(args.dist);
  if (args.mode === 'write') {
    mkdirSync(dirname(args.report), { recursive: true });
    writeFileSync(args.report, now);
    console.log(`check-dts-diff: wrote ${now.split('\n').length - 1} names to ${args.report}`);
    return 0;
  }
  if (!existsSync(args.report)) {
    console.error(`check-dts-diff: ${args.report} is missing; run node scripts/check-dts-diff.mjs --write`);
    return 1;
  }
  const rows = diffReports(readFileSync(args.report, 'utf8'), now);
  if (rows.length === 0) {
    console.log(`check-dts-diff: ${args.dist} matches ${args.report}`);
    return 0;
  }
  console.log(rows.join('\n'));
  console.error(`check-dts-diff: the published API changed. Run node scripts/check-dts-diff.mjs --write and commit ${args.report}.`);
  return 1;
}

process.exitCode = main();
