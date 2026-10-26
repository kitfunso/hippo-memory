#!/usr/bin/env node
// next/3.0 skips v57 to v59 until their branches land, and a store opened by a build with a gap would never run the
// skipped ones. First step of prepublishOnly, not CI: CI stays green while the gap is open, a publish must not.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MIGRATIONS_DIR = 'src/db/migrations';

/** The version each MIGRATIONS entry declares, in list order. */
export function readMigrationVersions(dir = MIGRATIONS_DIR) {
  const body = /export const MIGRATIONS: Migration\[\] = \[([\s\S]*?)\];/.exec(
    readFileSync(join(dir, 'index.ts'), 'utf8'),
  );
  if (!body) throw new Error(`${dir}/index.ts has no MIGRATIONS array.`);
  return (body[1].match(/\bv\d+\b/g) ?? []).map((name) => {
    const declared = /\bversion:\s*(\d+)/.exec(readFileSync(join(dir, `${name}.ts`), 'utf8'));
    if (!declared) throw new Error(`${dir}/${name}.ts declares no version.`);
    return Number(declared[1]);
  });
}

/** Each step of `versions`, in list order, that is not the previous version plus one. */
export function findMigrationGaps(versions) {
  const gaps = [];
  for (let i = 1; i < versions.length; i++) {
    if (versions[i] !== versions[i - 1] + 1) gaps.push({ after: versions[i - 1], next: versions[i] });
  }
  return gaps;
}

export function describeGap({ after, next }) {
  if (next <= after) return `v${next} follows v${after}, out of order or repeated.`;
  const missing = next - after === 2 ? `v${after + 1}` : `v${after + 1} to v${next - 1}`;
  return `v${after} is followed by v${next}, so ${missing} ${next - after === 2 ? 'is' : 'are'} missing.`;
}

// Guarded so importing this module (the test) neither runs the check nor exits.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const gaps = findMigrationGaps(readMigrationVersions(process.argv[2]));
  if (gaps.length > 0) {
    console.error('');
    console.error('MIGRATION LINE: the MIGRATIONS versions are not consecutive.');
    for (const gap of gaps) console.error(`  ${describeGap(gap)}`);
    console.error(
      'Fix: land the missing migrations before publishing, or renumber so each version is the previous plus one.',
    );
    console.error('');
    process.exit(1);
  }
  console.log('MIGRATIONS versions are consecutive. OK.');
}
