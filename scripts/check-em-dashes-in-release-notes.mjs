#!/usr/bin/env node
/**
 * Pre-publish guard: scan the CHANGELOG.md entry for the version about
 * to be published and reject if it contains em-dashes (U+2014).
 *
 * Per CLAUDE.md "Stop Slop" rule, em-dashes are forbidden in release
 * notes. Em-dash slips have shipped multiple times this week despite
 * post-commit grep backstops; this script catches them at the gate that
 * matters most (before npm publish).
 *
 * The check is SCOPED to the entry for the version in package.json,
 * NOT the whole CHANGELOG. Historical entries with em-dashes from before
 * the discipline are not in scope.
 *
 * Ticket: TODOS.md "Engineering hygiene (release pipeline)" #2.
 */

import { readFileSync } from 'node:fs';

const rootPkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = rootPkg.version;

const changelog = readFileSync('CHANGELOG.md', 'utf8');

// Extract the section for the current version: from "## X.Y.Z" up to
// the next "## " (or EOF). The regex is anchored to start-of-line.
const versionEscaped = version.replace(/\./g, '\\.');
const sectionRegex = new RegExp(
  `^## ${versionEscaped}[\\s\\S]*?(?=^## \\d|\\z)`,
  'm',
);
const match = changelog.match(sectionRegex);

if (!match) {
  console.error(`No CHANGELOG section found for version ${version}.`);
  console.error('Fix: add a "## ' + version + '" entry before publishing.');
  process.exit(1);
}

const section = match[0];
const emDashCount = (section.match(/—/g) || []).length;

if (emDashCount > 0) {
  console.error('');
  console.error(`EM-DASH detected in CHANGELOG section for ${version}:`);
  // Print each offending line with line number relative to the section.
  const lines = section.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('—')) {
      console.error(`  line ${i + 1}: ${lines[i]}`);
    }
  }
  console.error('');
  console.error('Fix: replace em-dashes with colons, commas, or sentence breaks.');
  console.error('Per CLAUDE.md "Stop Slop", em-dashes are forbidden in release notes.');
  console.error('See TODOS.md "Engineering hygiene (release pipeline)" #2 for context.');
  console.error('');
  process.exit(1);
}

console.log(`CHANGELOG section for ${version} is em-dash-free. OK.`);
