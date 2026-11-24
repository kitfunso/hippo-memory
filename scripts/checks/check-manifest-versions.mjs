#!/usr/bin/env node

import { readFileSync, existsSync } from 'node:fs';

const rootPkg = JSON.parse(readFileSync('package.json', 'utf8'));
const expectedVersion = rootPkg.version;

const LOCKSTEP_MANIFESTS = [
  'package.json',
  'openclaw.plugin.json',
  'extensions/openclaw-plugin/package.json',
  'extensions/openclaw-plugin/openclaw.plugin.json',
  'server.json',
  'gemini-extension.json',
  'extensions/kiro-power/plugin.json',
  'extensions/cursor-plugin/.cursor-plugin/plugin.json',
  'extensions/vscode/package.json',
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
  if (path === 'server.json') {
    // The MCP Registry rejects an npm package entry without its own version.
    for (const [i, pkg] of (parsed?.packages ?? []).entries()) {
      const found = manifestVersion(pkg);
      if (found !== expectedVersion) {
        drifts.push({
          path: `server.json packages[${i}]`,
          found: found ?? '(no version field)',
          expected: expectedVersion,
        });
      }
    }
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

const VERSION_TS = 'src/base/util/version.ts';
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

const LOCKFILE = 'package-lock.json';
if (!existsSync(LOCKFILE)) {
  drifts.push({ path: LOCKFILE, found: '(missing)', expected: expectedVersion });
} else {
  let lock;
  let parsed = true;
  try {
    lock = JSON.parse(readFileSync(LOCKFILE, 'utf8'));
  } catch (e) {
    parsed = false;
    drifts.push({ path: LOCKFILE, found: '(parse error: ' + e.message + ')', expected: expectedVersion });
  }
  if (parsed) {
    const lockstep = [
      [LOCKFILE + ' .version', manifestVersion(lock)],
      [LOCKFILE + ' .packages[""].version', manifestVersion(lock?.packages?.[''])],
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

console.log(
  `All ${LOCKSTEP_MANIFESTS.length} lockstep manifests + src/base/util/version.ts + the two package-lock.json root fields at version ${expectedVersion}. OK.`,
);
