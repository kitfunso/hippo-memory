import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROCESS_TESTS } from './_process-tests.js';
import { SERVER_TESTS } from './_server-tests.js';

// Built from pieces so this file matches neither pattern and stays in the fast class.
const STARTS_A_CHILD = new RegExp(String.raw`\bchild_` + 'process\\b');
// The worker store and the dashboard start their threads inside src, so a test that builds one never imports the thread
// module itself.
const STARTS_A_SERVER = new RegExp(
  String.raw`\bworker_` +
    'threads\\b|' +
    String.raw`\bserve\(|` +
    String.raw`\bserve` +
    'Dashboard\\(|' +
    String.raw`\bworkerSqlite` +
    'Store\\(',
);
const tests = import.meta.dirname;
const read = (file: string): string => readFileSync(join(tests, file), 'utf8');

const helpers = readdirSync(join(tests, '_helpers')).map((file) => ({
  name: file.replace(/\.\w+$/, ''),
  source: read(join('_helpers', file)),
}));
const testFiles = readdirSync(tests, { recursive: true, encoding: 'utf8' })
  .filter((file) => /\.test\.(ts|mjs)$/.test(file))
  .map((file) => ({ path: `tests/${file.replaceAll('\\', '/')}`, source: read(file) }));

/** Test files that match `starts` in their own code or through a _helpers module that does. */
function filesThatStart(starts: RegExp): string[] {
  const starters = new Set(helpers.filter((helper) => starts.test(helper.source)).map((helper) => helper.name));
  const importsStarter = (source: string): boolean =>
    new RegExp(`(?:_helpers|\\.)/(?:${[...starters].join('|')})\\.`).test(source);
  // A helper that imports a starter is one too, so this repeats until a pass adds none.
  for (let known = -1; known !== starters.size;) {
    known = starters.size;
    for (const helper of helpers) if (importsStarter(helper.source)) starters.add(helper.name);
  }
  return testFiles
    .filter((file) => starts.test(file.source) || importsStarter(file.source))
    .map((file) => file.path)
    .sort();
}

const startsChild = filesThatStart(STARTS_A_CHILD);
// A file that does both stays in PROCESS_TESTS.
const startsOnlyServer = filesThatStart(STARTS_A_SERVER).filter((file) => !startsChild.includes(file));

describe('PROCESS_TESTS', () => {
  it('lists every test file that starts a child process, so it gets the 30 s timeout', () => {
    expect(startsChild.filter((file) => !PROCESS_TESTS.includes(file))).toEqual([]);
  });

  it('lists no file that no longer starts one, so the fast class stays fast', () => {
    expect(PROCESS_TESTS.filter((file) => !startsChild.includes(file))).toEqual([]);
  });

  it('is sorted and has no duplicates', () => {
    expect([...PROCESS_TESTS]).toEqual([...new Set(PROCESS_TESTS)].sort());
  });
});

describe('SERVER_TESTS', () => {
  it('lists every test file that starts the server or a worker thread and no child process', () => {
    expect(startsOnlyServer.filter((file) => !SERVER_TESTS.includes(file))).toEqual([]);
  });

  it('lists no file that starts a child process or starts neither, so each file is in one list', () => {
    expect(SERVER_TESTS.filter((file) => !startsOnlyServer.includes(file))).toEqual([]);
  });

  it('is sorted and has no duplicates', () => {
    expect([...SERVER_TESTS]).toEqual([...new Set(SERVER_TESTS)].sort());
  });
});
