import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROCESS_TESTS } from './_process-tests.js';

// Built from pieces so this file does not match its own pattern and land in the slow class.
const STARTS_A_PROCESS = new RegExp(String.raw`\bchild_` + 'process\\b|' + String.raw`\bworker_` + 'threads\\b|' + String.raw`\bserve\(`);
const tests = import.meta.dirname;
const read = (file: string): string => readFileSync(join(tests, file), 'utf8');

/** Test files that start a process, a worker thread or the HTTP server, in their own code or through a _helpers module. */
function filesThatStartAProcess(): string[] {
  const helpers = readdirSync(join(tests, '_helpers')).map((file) => ({ name: file.replace(/\.\w+$/, ''), source: read(join('_helpers', file)) }));
  const starters = new Set(helpers.filter((helper) => STARTS_A_PROCESS.test(helper.source)).map((helper) => helper.name));
  const importsStarter = (source: string): boolean => new RegExp(`(?:_helpers|\\.)/(?:${[...starters].join('|')})\\.`).test(source);
  // A helper that imports a starter is one too, so this repeats until a pass adds none.
  for (let known = -1; known !== starters.size;) {
    known = starters.size;
    for (const helper of helpers) if (importsStarter(helper.source)) starters.add(helper.name);
  }
  return readdirSync(tests, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.test\.(ts|mjs)$/.test(file))
    .filter((file) => { const source = read(file); return STARTS_A_PROCESS.test(source) || importsStarter(source); })
    .map((file) => `tests/${file.replaceAll('\\', '/')}`)
    .sort();
}

describe('PROCESS_TESTS', () => {
  const found = filesThatStartAProcess();

  it('lists every test file that starts a process, so it gets the 30 s timeout', () => {
    expect(found.filter((file) => !PROCESS_TESTS.includes(file))).toEqual([]);
  });

  it('lists no file that no longer starts one, so the fast class stays fast', () => {
    expect(PROCESS_TESTS.filter((file) => !found.includes(file))).toEqual([]);
  });

  it('is sorted and has no duplicates', () => {
    expect([...PROCESS_TESTS]).toEqual([...new Set(PROCESS_TESTS)].sort());
  });
});
