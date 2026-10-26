#!/usr/bin/env node
/** Pre-publish guard: every `.ts` openclaw.extensions entry needs a compiled dist/ twin that Node can import as ESM; a missing twin broke every install before 1.38.1, and a CommonJS emit under the ESM root scope throws at load. */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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
    missing.push(`${distPath} (missing)`);
    continue;
  }
  try {
    await import(pathToFileURL(path.resolve(distPath)).href);
  } catch (err) {
    missing.push(`${distPath} (does not load: ${err instanceof Error ? err.message : String(err)})`);
  }
}

if (missing.length > 0) {
  console.error('Broken compiled dist twin for openclaw.extensions entries:');
  for (const p of missing) {
    console.error(`  - ${p}`);
  }
  process.exit(1);
}

console.log(`OK: ${checked} openclaw.extensions .ts entries have a compiled dist twin that loads.`);
