#!/usr/bin/env node
// A store's floor rises to one of these constants when it first uses that schema, so each must name a release that
// ships the schema: an older binary would open the store and misread it. Wired beside check-manifest-versions.mjs.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const VERSION_TS = 'src/version.ts';
const MIGRATIONS_INDEX = 'src/db/migrations/index.ts';
const FLOORS = [
  ['EXPIRING_KEYS_MIN_BINARY', 53],
  ['TASK_OWNER_MIN_BINARY', 54],
];

function fail(message) {
  console.error('');
  console.error(`BINARY FLOOR: ${message}`);
  console.error('Fix: in the release that first ships a floor\'s schema, set that constant in src/version.ts to that release.');
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
const packageParts = parseVersion(String(packageVersion));
const versionSource = readFileSync(VERSION_TS, 'utf8');
const floors = FLOORS.map(([name, schema]) => {
  const floor = new RegExp(`export const ${name} = '([^']+)'`).exec(versionSource)?.[1];
  if (floor === undefined) fail(`${name} not found in ${VERSION_TS}.`);
  const floorParts = parseVersion(floor);
  if (!floorParts || !packageParts) fail(`expected plain x.y.z versions, got ${name} ${floor} and package ${packageVersion}.`);
  // A floor above the running binary would lock the binary out of every store that reaches it.
  if (isAbove(floorParts, packageParts)) fail(`${name} ${floor} is above the package version ${packageVersion}.`);
  return { name, schema, floor };
});

// With no tags every check below passes by finding nothing, so a shallow clone must fail rather than pass.
const tagList = git('tag', '--list');
if (tagList.status !== 0) fail(`git tag --list failed: ${tagList.stderr.trim()}`);
const tags = new Set(tagList.stdout.split(/\r?\n/).map((t) => t.trim()).filter(Boolean));
if (tags.size === 0) fail('no git tags in this checkout, so no floor can be checked; fetch with tags (fetch-depth: 0).');

for (const { name, schema, floor } of floors) {
  const tag = `v${floor}`;
  if (!tags.has(tag)) continue;
  const index = git('show', `${tag}:${MIGRATIONS_INDEX}`);
  if (index.status !== 0 || !new RegExp(`\\bv${schema}\\b`).test(index.stdout)) fail(`release ${tag} does not ship schema v${schema}, so it cannot be ${name}.`);
}

for (const { name, schema, floor } of floors) {
  console.log(`${name} ${floor}: at or below package ${packageVersion}, and no release before schema v${schema} carries it. OK.`);
}
