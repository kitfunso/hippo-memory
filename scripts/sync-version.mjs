#!/usr/bin/env node
// The `version` lifecycle script: `npm version <x> --no-git-tag-version` bumps package.json and the
// lockfile, then this copies the version to the sites npm does not know about.
// check-manifest-versions.mjs runs right after it and stays the publish gate.

import { readFileSync, writeFileSync } from 'node:fs';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;

const JSON_MANIFESTS = [
  'openclaw.plugin.json',
  'extensions/openclaw-plugin/package.json',
  'extensions/openclaw-plugin/openclaw.plugin.json',
];

for (const path of JSON_MANIFESTS) {
  // Replace in place so each file keeps its own layout; the parse catches a nested "version" listed first.
  const next = readFileSync(path, 'utf8').replace(/("version"\s*:\s*")[^"]*"/, `$1${version}"`);
  if (JSON.parse(next).version !== version) throw new Error(`${path}: top-level "version" not found`);
  writeFileSync(path, next);
}

const VERSION_TS = 'src/version.ts';
const PATTERN = /export const PACKAGE_VERSION = '[^']+'/;
const ts = readFileSync(VERSION_TS, 'utf8');
if (!PATTERN.test(ts)) throw new Error(`${VERSION_TS}: PACKAGE_VERSION not found`);
writeFileSync(VERSION_TS, ts.replace(PATTERN, `export const PACKAGE_VERSION = '${version}'`));

console.log(`Set ${JSON_MANIFESTS.length} manifests and ${VERSION_TS} to ${version}.`);
