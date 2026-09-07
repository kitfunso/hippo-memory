#!/usr/bin/env node
/**
 * Pre-publish guard: assert every JSON manifest in the repo declares the
 * same `"version"` as the root `package.json`. Manifest version drift
 * shipped 3 versions in 7 days (v1.12.11 publish slip, v1.12.12 bundled
 * fix, v1.13.1 nested manifest drift) before this check existed; each
 * slip cost a follow-up patch ship. This script ends the class.
 *
 * Wired into `prepublishOnly` in package.json. Exits non-zero with a
 * specific error message if any drift exists. Ignores node_modules, and
 * ignores the lockfile's dependency entries, which carry their own versions.
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

/**
 * Read the "version" field off a parsed manifest as a validated string, or
 * null when it's absent or not a string. Boundary parse for a value that
 * came straight out of JSON.parse() (untyped by definition).
 * @param {unknown} parsed
 * @returns {string | null}
 */
function manifestVersion(parsed) {
  const value = parsed?.version;
  return Object.prototype.toString.call(value) === '[object String]' ? value : null;
}

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
  const version = manifestVersion(parsed);
  if (version === null) {
    drifts.push({ path, found: '(no version field)', expected: expectedVersion });
    continue;
  }
  if (version !== expectedVersion) {
    drifts.push({ path, found: version, expected: expectedVersion });
  }
}

// src/version.ts carries PACKAGE_VERSION as a TS constant (not JSON). Its own
// header names it the "fifth manifest" bumped manually every release, but it was
// historically excluded from this guard, so it silently drifted (1.12.10 vs
// published 1.14.0) across two releases while feeding MCP serverInfo, the HTTP
// /health endpoint, and the DB rollback-compat gate. Assert it here so the
// documented manual bump can never be silently skipped again.
const VERSION_TS = 'src/version.ts';
if (!existsSync(VERSION_TS)) {
  drifts.push({ path: VERSION_TS, found: '(missing)', expected: expectedVersion });
} else {
  const src = readFileSync(VERSION_TS, 'utf8');
  const m = src.match(/export const PACKAGE_VERSION = '([^']+)'/);
  if (!m) {
    drifts.push({ path: VERSION_TS, found: '(PACKAGE_VERSION not found)', expected: expectedVersion });
  } else if (m[1] !== expectedVersion) {
    drifts.push({ path: VERSION_TS, found: m[1], expected: expectedVersion });
  }
}

// The lockfile was excluded wholesale for a property only part of it has. Its
// `packages["node_modules/..."]` entries do carry independent dependency
// versions, but `.version` and `.packages[""].version` mirror the root package
// and npm rewrites both on every `npm version`. Excluding the file let a stale
// pair sail past this gate on v1.38.9. Check the two lockstep fields only.
const LOCKFILE = 'package-lock.json';
if (!existsSync(LOCKFILE)) {
  drifts.push({ path: LOCKFILE, found: '(missing)', expected: expectedVersion });
} else {
  let lock = null;
  try {
    lock = JSON.parse(readFileSync(LOCKFILE, 'utf8'));
  } catch (e) {
    drifts.push({ path: LOCKFILE, found: '(parse error: ' + e.message + ')', expected: expectedVersion });
  }
  if (lock !== null) {
    const lockstep = [
      [LOCKFILE + ' .version', manifestVersion(lock)],
      [LOCKFILE + ' .packages[""].version', manifestVersion(lock.packages?.[''])],
    ];
    for (const [label, version] of lockstep) {
      if (version === null) {
        drifts.push({ path: label, found: '(no version field)', expected: expectedVersion });
      } else if (version !== expectedVersion) {
        drifts.push({ path: label, found: version, expected: expectedVersion });
      }
    }
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
  console.error('For package-lock.json, `npm install --package-lock-only` rewrites both fields.');
  console.error('See TODOS.md "Engineering hygiene (release pipeline)" #1 for context.');
  console.error('');
  process.exit(1);
}

console.log(`All ${LOCKSTEP_MANIFESTS.length} lockstep manifests + src/version.ts + the two package-lock.json root fields at version ${expectedVersion}. OK.`);
