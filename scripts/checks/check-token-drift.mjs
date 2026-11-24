#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep, resolve } from 'node:path';

const LEGACY_HEX_PATTERNS = [
  /#0c0e14\b/g,
  /#080a10\b/g,
  /#050709\b/g,
  /#0a0c10\b/g,
  /#14161e\b/g,
  /#e1e4ed\b/g,
  /#6b7084\b/g,
  /#7c5cff\b/g,
  /0x7c5cff\b/gi,
  /#f0a030\b/g,
  /0xf0a030\b/gi,
  /#ff4466\b/g,
  /0xff4466\b/gi,
  /#34d399\b/g,
  /0x34d399\b/gi,
  /#0f1117\b/g,
  /#1a1d27\b/g,
  /#2a2d3a\b/g,
  /#8b8fa3\b/g,
  /#6c8cff\b/g,
  /#4ade80\b/g,
  /#fbbf24\b/g,
  /#8aa4ff\b/g,
];

const REPO_ROOT = resolve(import.meta.dirname, '../..');

const SCAN_PATHS = ['ui/index.html', 'ui/src', 'src/surface/dashboard/dashboard.ts'];

const EXEMPT_FILES = new Set([
  'ui/src/tokens.ts',
  'ui/src/tokens.css',
]);

const EXEMPT_EXTENSIONS = new Set([
  '.md',
  '.png',
  '.jpg',
  '.gif',
  '.svg',
  '.ico',
  '.woff2',
  '.json',
]);

function shouldScan(filePath) {
  const rel = relative(REPO_ROOT, filePath).split(sep).join('/');
  if (EXEMPT_FILES.has(rel)) return false;
  for (const ext of EXEMPT_EXTENSIONS) {
    if (filePath.toLowerCase().endsWith(ext)) return false;
  }
  return true;
}

function walk(p) {
  const out = [];
  const st = statSync(p);
  if (st.isFile()) {
    if (shouldScan(p)) out.push(p);
  } else if (st.isDirectory()) {
    for (const entry of readdirSync(p)) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'dist-ui') continue;
      out.push(...walk(join(p, entry)));
    }
  }
  return out;
}

const quiet = process.argv.includes('--quiet');
const drifts = [];

for (const target of SCAN_PATHS) {
  const abs = join(REPO_ROOT, target);
  for (const file of walk(abs)) {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pattern of LEGACY_HEX_PATTERNS) {
        const matches = line.match(pattern);
        if (matches) {
          drifts.push({
            file: relative(REPO_ROOT, file),
            line: i + 1,
            match: matches[0],
            content: line.trim().slice(0, 100),
          });
        }
        pattern.lastIndex = 0;
      }
    }
  }
}

if (drifts.length === 0) {
  if (!quiet) {
    console.log('✓ check-token-drift: 0 legacy hex codes outside canonical sources');
  }
  process.exit(0);
}

console.error(`✗ check-token-drift: ${drifts.length} legacy hex code(s) found:\n`);
for (const d of drifts) {
  console.error(`  ${d.file}:${d.line}  ${d.match}`);
  if (!quiet) {
    console.error(`    | ${d.content}`);
  }
}
console.error(`\nFix: replace with imports from ui/src/tokens.ts or var(--*) from ui/src/tokens.css.`);
console.error(`Migration map: docs/plans/2026-05-24-ui-token-migration-map.md`);
process.exit(1);
