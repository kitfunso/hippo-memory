#!/usr/bin/env node
/** Picks the npm dist-tag for `npm publish --tag`: npm 11 refuses to publish a
 *  version below the current `latest` without one, which would block a patch
 *  release on an older supported minor (npm/lib/commands/publish.js:179-181). */

import { pathToFileURL } from 'node:url';

const REGISTRY_DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/hippo-memory/dist-tags';
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

// x.y.z[-pre] only: throws early so a bad version never reaches npm publish.
function parseVersion(version) {
  const m = VERSION_RE.exec(version);
  if (!m) throw new Error(`invalid version: ${version}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ?? null };
}

// Numeric, not string, compare: minor 10 sorts after minor 9 as an integer.
function compareCore(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** `next` for a prerelease; `latest` when there is none yet or version is newer;
 *  else the maint tag for its minor, so a backport never moves `latest` back. */
export function distTagFor(version, latest) {
  const v = parseVersion(version);
  if (v.prerelease) return 'next';
  if (latest === null || latest === undefined) return 'latest';
  const l = parseVersion(latest);
  return compareCore(v, l) > 0 ? 'latest' : `maint-${v.major}.${v.minor}`;
}

/** Current `latest` dist-tag, or null when the package has never published
 *  (404). Fails closed: any other status or network error throws. */
async function fetchLatest() {
  let resp;
  try {
    resp = await fetch(REGISTRY_DIST_TAGS_URL);
  } catch (err) {
    throw new Error(`registry request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`registry returned HTTP ${resp.status} ${resp.statusText}`);
  const body = await resp.json();
  return body.latest ?? null;
}

// Guarded so importing this module (e.g. from the test) does not hit the
// network or process.exit. pathToFileURL(argv[1]) normalises cross-platform.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv[2];
  if (!version) {
    console.error('usage: node scripts/publish-dist-tag.mjs <version>');
    process.exit(1);
  }
  try {
    const latest = await fetchLatest();
    console.log(distTagFor(version, latest));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
