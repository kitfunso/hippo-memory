#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;

const JSON_MANIFESTS = [
  'openclaw.plugin.json',
  'extensions/openclaw-plugin/package.json',
  'extensions/openclaw-plugin/openclaw.plugin.json',
  'server.json',
  'gemini-extension.json',
  'extensions/kiro-power/plugin.json',
  'extensions/cursor-plugin/.cursor-plugin/plugin.json',
  'extensions/vscode/package.json',
];

// server.json also pins each package's version, which the MCP Registry requires for npm packages.
const EVERY_VERSION = new Set(['server.json']);

for (const path of JSON_MANIFESTS) {
  const pattern = EVERY_VERSION.has(path) ? /("version"\s*:\s*")[^"]*"/g : /("version"\s*:\s*")[^"]*"/;
  const next = readFileSync(path, 'utf8').replace(pattern, `$1${version}"`);
  const parsed = JSON.parse(next);
  if (parsed.version !== version) throw new Error(`${path}: top-level "version" not found`);
  if (EVERY_VERSION.has(path) && !(parsed.packages ?? []).every((p) => p.version === version)) {
    throw new Error(`${path}: a package has no "version"`);
  }
  writeFileSync(path, next);
}

const VERSION_TS = 'src/base/util/version.ts';
const PATTERN = /export const PACKAGE_VERSION = '[^']+'/;
const ts = readFileSync(VERSION_TS, 'utf8');
if (!PATTERN.test(ts)) throw new Error(`${VERSION_TS}: PACKAGE_VERSION not found`);
writeFileSync(VERSION_TS, ts.replace(PATTERN, `export const PACKAGE_VERSION = '${version}'`));

console.log(`Set ${JSON_MANIFESTS.length} manifests and ${VERSION_TS} to ${version}.`);
