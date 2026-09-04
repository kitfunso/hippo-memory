#!/usr/bin/env node
/** Pre-publish guard: every `.ts` openclaw.extensions entry needs a compiled dist/ twin, or `openclaw plugins install` of the published package fails (no release ever shipped it before 1.38.1). */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const rootPkg = JSON.parse(readFileSync('package.json', 'utf8'));
const extensions = rootPkg.openclaw?.extensions ?? [];

const missing = [];
let checked = 0;
for (const entry of extensions) {
  if (!entry.endsWith('.ts')) continue;
  const relative = entry.replace(/^\.\//, '');
  const distPath = path.join('dist', relative.replace(/\.ts$/, '.js'));
  checked += 1;
  if (!existsSync(distPath)) {
    missing.push(distPath);
  }
}

if (missing.length > 0) {
  console.error('Missing compiled dist twin for openclaw.extensions entries:');
  for (const p of missing) {
    console.error(`  - ${p}`);
  }
  process.exit(1);
}

console.log(`OK: ${checked} openclaw.extensions .ts entries have a compiled dist twin.`);
