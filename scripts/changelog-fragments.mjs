#!/usr/bin/env node
// One changelog.d/ fragment per PR keeps open PRs from conflicting on CHANGELOG.md.
// `fold [YYYY-MM-DD]` writes them under the package.json version and deletes them;
// `check` (prepublishOnly) fails while any are left.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'changelog.d';
const FIRST = ['Added', 'Changed', 'Fixed', 'Security', 'Documentation'];

function fail(message) {
  console.error(message);
  process.exit(1);
}

const fragments = existsSync(DIR)
  ? readdirSync(DIR).filter((f) => f.endsWith('.md') && f !== 'README.md').sort()
  : [];

function check() {
  if (fragments.length > 0) {
    fail(
      `changelog.d/ still holds ${fragments.length} unfolded fragment(s): ${fragments.join(', ')}.\n` +
        'Fix: run `node scripts/changelog-fragments.mjs fold` after the version bump and commit the result.',
    );
  }
  console.log('changelog.d/ holds no unfolded fragments. OK.');
}

function readSections() {
  const sections = new Map();
  for (const file of fragments) {
    const text = readFileSync(join(DIR, file), 'utf8').replace(/\r\n/g, '\n');
    if (/^## /m.test(text)) fail(`changelog.d/${file}: a fragment takes ### headings only, no ## heading.`);
    const [before, ...parts] = text.split(/^### /m);
    if (before.trim()) fail(`changelog.d/${file}: text before its first ### heading.`);
    for (const part of parts) {
      const nl = part.indexOf('\n');
      const heading = (nl < 0 ? part : part.slice(0, nl)).trim();
      const body = nl < 0 ? '' : part.slice(nl + 1).trim();
      if (body) sections.set(heading, [...(sections.get(heading) ?? []), body]);
    }
  }
  return sections;
}

function fold(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`fold: the date must be YYYY-MM-DD, got "${date}".`);
  if (fragments.length === 0) fail('fold: changelog.d/ holds no fragments.');
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  const changelog = readFileSync('CHANGELOG.md', 'utf8');
  if (new RegExp(`^## ${version.replace(/\./g, '\\.')}(?![\\w.-])`, 'm').test(changelog)) {
    fail(`fold: CHANGELOG.md already has a ## ${version} section.`);
  }
  const sections = readSections();
  if (sections.size === 0) fail('fold: the fragments hold no entries.');
  const rank = (h) => (FIRST.includes(h) ? FIRST.indexOf(h) : FIRST.length);
  const block = [...sections.keys()]
    .sort((a, b) => rank(a) - rank(b))
    .map((h) => `### ${h}\n\n${sections.get(h).join('\n')}\n`)
    .join('\n');
  const entry = `## ${version} - ${date}\n\n${block}\n`;
  const at = changelog.search(/^## /m);
  writeFileSync(
    'CHANGELOG.md',
    at < 0 ? `${changelog.trimEnd()}\n\n${entry}` : changelog.slice(0, at) + entry + changelog.slice(at),
  );
  for (const file of fragments) rmSync(join(DIR, file));
  console.log(`Folded ${fragments.length} fragment(s) into ## ${version} - ${date}.`);
}

const [mode, date = new Date().toISOString().slice(0, 10)] = process.argv.slice(2);
if (mode === 'check') check();
else if (mode === 'fold') fold(date);
else fail('usage: node scripts/changelog-fragments.mjs check | fold [YYYY-MM-DD]');
