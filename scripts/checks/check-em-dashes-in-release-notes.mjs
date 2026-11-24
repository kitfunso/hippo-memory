#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const rootPkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = rootPkg.version;

const changelog = readFileSync('CHANGELOG.md', 'utf8');

// JS has no \z: it matched a literal "z" and cut the section at the first one.
const versionEscaped = version.replace(/\./g, '\\.');
const sectionRegex = new RegExp(`^## ${versionEscaped}[\\s\\S]*?(?=^## \\d|(?![\\s\\S]))`, 'm');
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
