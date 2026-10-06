#!/usr/bin/env node
// A store's first expiring key raises its floor to EXPIRING_KEYS_MIN_BINARY, so that constant must name a release that
// ships schema v53: an older one ignores expires_at and would honour expired keys. Wired beside check-manifest-versions.mjs.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const VERSION_TS = 'src/version.ts';
const MIGRATIONS_INDEX = 'src/db/migrations/index.ts';

function fail(message) {
  console.error('');
  console.error(`EXPIRING KEYS FLOOR: ${message}`);
  console.error('Fix: in the release that first ships schema v53, set EXPIRING_KEYS_MIN_BINARY in src/version.ts to that release.');
  console.error('');
  process.exit(1);
}

/** Plain x.y.z as numbers, or null for anything else. */
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isAbove(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function git(...args) {
  return spawnSync('git', args, { encoding: 'utf-8' });
}

const packageVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
const floor = /export const EXPIRING_KEYS_MIN_BINARY = '([^']+)'/.exec(readFileSync(VERSION_TS, 'utf8'))?.[1];
if (floor === undefined) fail(`EXPIRING_KEYS_MIN_BINARY not found in ${VERSION_TS}.`);
const floorParts = parseVersion(floor);
const packageParts = parseVersion(String(packageVersion));
if (!floorParts || !packageParts) fail(`expected plain x.y.z versions, got floor ${floor} and package ${packageVersion}.`);
// A floor above the running binary would lock the binary out of every store it gives an expiring key.
if (isAbove(floorParts, packageParts)) fail(`EXPIRING_KEYS_MIN_BINARY ${floor} is above the package version ${packageVersion}.`);

const tag = `v${floor}`;
const tags = git('tag', '--list', tag);
if (tags.status !== 0) fail(`git tag --list failed: ${tags.stderr.trim()}`);
if (tags.stdout.trim() === tag) {
  const index = git('show', `${tag}:${MIGRATIONS_INDEX}`);
  if (index.status !== 0 || !/\bv53\b/.test(index.stdout)) fail(`release ${tag} does not ship schema v53, so it cannot be the floor.`);
}

console.log(`EXPIRING_KEYS_MIN_BINARY ${floor}: at or below package ${packageVersion}, and no release before schema v53 carries it. OK.`);
