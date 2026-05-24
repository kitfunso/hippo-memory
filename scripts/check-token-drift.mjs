#!/usr/bin/env node
/**
 * Token drift CI guard (E1 deliverable of the hybrid-v4 revamp).
 *
 * Fails if any legacy dark-observatory hex codes appear outside the canonical
 * token sources (ui/src/tokens.ts, ui/src/tokens.css). Prevents the same
 * 4-surface drift caught by plan-eng-critic round 1 from recurring.
 *
 * Usage:
 *   node scripts/check-token-drift.mjs           # exit 1 on drift
 *   node scripts/check-token-drift.mjs --quiet   # only print drift lines
 *
 * Wire into ui/ test script or pre-commit hook.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Banned patterns — legacy dark-observatory tokens that must not reappear.
// ---------------------------------------------------------------------------

const LEGACY_HEX_PATTERNS = [
  // Dark observatory body bg + gradients (particles.ts L112-114 originals)
  /#0c0e14\b/g,
  /#080a10\b/g,
  /#050709\b/g,
  // Dark observatory ui/index.html :root originals
  /#0a0c10\b/g,
  /#14161e\b/g,
  /#e1e4ed\b/g,
  /#6b7084\b/g,
  // Old purple accent (was --accent, now --buffer)
  /#7c5cff\b/g,
  /0x7c5cff\b/gi,
  // Old episodic orange (now blue)
  /#f0a030\b/g,
  /0xf0a030\b/gi,
  // Old conflict red
  /#ff4466\b/g,
  /0xff4466\b/gi,
  // Old semantic green (replaced by darker parchment-friendly green)
  /#34d399\b/g,
  /0x34d399\b/gi,
  // Old dashboardHTML drifted tokens (the 7/10 mismatches the migration
  // map called out — these never matched ui/index.html and are now deleted)
  /#0f1117\b/g,
  /#1a1d27\b/g,
  /#2a2d3a\b/g,
  /#8b8fa3\b/g,
  /#6c8cff\b/g,
  /#4ade80\b/g,
  /#fbbf24\b/g,
  /#8aa4ff\b/g,
];

// ---------------------------------------------------------------------------
// Files to scan + files exempted (canonical sources).
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dirname, '..');

const SCAN_PATHS = [
  'ui/index.html',
  'ui/src',
  'src/dashboard.ts',
];

const EXEMPT_FILES = new Set([
  // The canonical token sources — they SHOULD contain the new parchment
  // hex codes, but not legacy ones. The patterns above are all legacy.
  'ui/src/tokens.ts',
  'ui/src/tokens.css',
  // Migration map documents the old→new mapping; exempt by extension below.
]);

const EXEMPT_EXTENSIONS = new Set([
  '.md', // migration map + design docs cite legacy hex for reference
  '.png', '.jpg', '.gif', '.svg', '.ico', '.woff2', // binaries
  '.json', // package-lock noise
]);

function shouldScan(filePath) {
  const rel = relative(REPO_ROOT, filePath).split(sep).join('/');
  if (EXEMPT_FILES.has(rel)) return false;
  for (const ext of EXEMPT_EXTENSIONS) {
    if (filePath.toLowerCase().endsWith(ext)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Walk + scan
// ---------------------------------------------------------------------------

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
        pattern.lastIndex = 0; // reset global regex state between lines
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
