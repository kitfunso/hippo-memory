#!/usr/bin/env node
/**
 * Pre-publish guard: assert every JSON manifest in the repo declares the
 * same `"version"` as the root `package.json`. Manifest version drift
 * shipped 3 versions in 7 days (v1.12.11 publish slip, v1.12.12 bundled
 * fix, v1.13.1 nested manifest drift) before this check existed; each
 * slip cost a follow-up patch ship. This script ends the class.
 *
 * Wired into `prepublishOnly` in package.json. Exits non-zero with a
 * specific error message if any drift exists. Ignores node_modules and
 * package-lock.json (the lockfile has its own multi-version semantics).
 *
 * Ticket: TODOS.md "Engineering hygiene (release pipeline)" #1.
 */

import { readFileSync, existsSync } from 'node:fs';

const rootPkg = JSON.parse(readFileSync('package.json', 'utf8'));
const expectedVersion = rootPkg.version;

// Explicit allowlist of manifests that MUST match root package.json version.
// Independent packages (ui/, extensions/claude-code-plugin/) have their OWN
// versioning and are excluded; historical eval results in docs/evals/ and
// results/ are snapshots and excluded.
//
// To add a new lockstep manifest, append to this list. To exclude a
// previously-tracked manifest (e.g. ui/ became its own release cadence),
// remove from this list.
const LOCKSTEP_MANIFESTS = [
  'package.json',
  'openclaw.plugin.json',
  'extensions/openclaw-plugin/package.json',
  'extensions/openclaw-plugin/openclaw.plugin.json',
];

const drifts = [];
for (const path of LOCKSTEP_MANIFESTS) {
  if (!existsSync(path)) {
    drifts.push({ path, found: '(missing)', expected: expectedVersion });
    continue;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    drifts.push({ path, found: '(parse error: ' + e.message + ')', expected: expectedVersion });
    continue;
  }
  if (typeof parsed.version !== 'string') {
    drifts.push({ path, found: '(no version field)', expected: expectedVersion });
    continue;
  }
  if (parsed.version !== expectedVersion) {
    drifts.push({ path, found: parsed.version, expected: expectedVersion });
  }
}

if (drifts.length > 0) {
  console.error('');
  console.error('VERSION DRIFT detected. The following manifests do not match package.json:');
  for (const d of drifts) {
    console.error(`  - ${d.path}: ${d.found} (expected ${d.expected})`);
  }
  console.error('');
  console.error('Fix: bump the drifted manifests to ' + expectedVersion + ' before publishing.');
  console.error('See TODOS.md "Engineering hygiene (release pipeline)" #1 for context.');
  console.error('');
  process.exit(1);
}

console.log(`All ${LOCKSTEP_MANIFESTS.length} lockstep manifests at version ${expectedVersion}. OK.`);
