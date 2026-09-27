#!/usr/bin/env node
// Open-core guard: fails when a change adds commercial-only files or identifiers to the MIT repo.
// The commercial list is in README "Open source and commercial"; the override is a line `open-core: reviewed`.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SCOPED_DIRS = ['src', 'extensions', 'integrations', 'ui', 'python'];
// Lockfile hashes are random base64 and hit `sso` by chance.
const EXCLUDES = [':(exclude,glob)**/package-lock.json', ':(exclude,glob)**/*.lock'];
export const OVERRIDE_RE = /^\s*open-core:\s*reviewed\s*$/im;
const TERM_RE = /saml|scim|siem|oidc[-_ ]?login|(?:^|[^a-z])sso(?:[^a-z]|$)|licen[cs]e[-_ ]?keys?|admin[-_ ]?view|pilot[-_ ]?report/;
const MARKER_RE = /\/\/\s*commercial\b/i;

// Splits camelCase so `ssoLogin` and `adminView` match while `processor` does not.
const normalise = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

export function matchesCommercial(text) {
  return TERM_RE.test(normalise(text)) || MARKER_RE.test(text);
}

/** Scans a unified diff (`git diff -U0`) for added commercial paths and lines. */
export function findViolations(diff) {
  const hits = [];
  let file = null;
  for (const raw of diff.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const header = line.match(/^diff --git a\/.* b\/(.+)$/);
    if (header) {
      file = header[1];
      if (matchesCommercial(file)) hits.push(`${file}: path`);
    } else if (file && line.startsWith('+') && !line.startsWith('+++ ') && matchesCommercial(line.slice(1))) {
      hits.push(`${file}: ${line.slice(1).trim().slice(0, 120)}`);
    }
  }
  return hits;
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

function resolveBase(argv, event) {
  const i = argv.indexOf('--base');
  if (i >= 0) return argv[i + 1];
  if (event?.pull_request) return git('merge-base', 'HEAD', event.pull_request.base.sha).trim();
  if (process.env.GITHUB_EVENT_NAME === 'push') return 'HEAD~1';
  return git('merge-base', 'HEAD', 'origin/master').trim();
}

function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const event = eventPath ? JSON.parse(readFileSync(eventPath, 'utf8')) : null;
  const base = resolveBase(process.argv, event);
  const diff = git('diff', '-U0', '--no-color', '--diff-filter=AMR', base, 'HEAD', '--', ...SCOPED_DIRS, ...EXCLUDES);
  const hits = findViolations(diff);
  if (hits.length === 0) return console.log(`check-open-core: clean against ${base}`);
  const notes = `${event?.pull_request?.body ?? ''}\n${git('log', '--format=%B', `${base}..HEAD`)}`;
  if (OVERRIDE_RE.test(notes)) {
    return console.log(`check-open-core: ${hits.length} match(es) cleared by "open-core: reviewed"`);
  }
  console.error('check-open-core: this change adds what looks like commercial-only code (see CONTRIBUTING.md):');
  for (const h of hits) console.error(`  ${h}`);
  console.error('If it is core, add a line "open-core: reviewed" to the PR body or a commit message.');
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
