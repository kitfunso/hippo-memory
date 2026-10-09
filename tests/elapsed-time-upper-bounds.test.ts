// An upper bound on how long something took fails when the runner stalls, not when the code gets worse; no test may assert one.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS = fileURLToPath(new URL('.', import.meta.url));
// This file holds the shapes as sample text.
const SELF = 'elapsed-time-upper-bounds.test.ts';
const CLOCK = String.raw`(?:Date\.now\(\)|performance\.now\(\)|hrtime(?:\.bigint)?\(\))`;
// A clock read minus a start time held in a variable; minus a constant is a moment in the past, not a duration.
const CLOCK_DIFF = new RegExp(String.raw`${CLOCK}\s*-\s*[a-z_$][\w$.]*(?!\s*[*(/\w$.])`);
const ASSIGNED = new RegExp(String.raw`(?<![\w$.])([A-Za-z_$][\w$]*)\s*=[^=;\n]*?${CLOCK_DIFF.source}`, 'g');
// Names a helper or a spawned process gives a duration it measured itself.
const REPORTED = /(?<![\w$])(?:elapsed|elapsedMs|durationMs|wallMs|tookMs)\b/;
const MATCHER = /^\s*\.\s*(not\s*\.\s*)?(toBeLessThan|toBeLessThanOrEqual|toBeGreaterThan|toBeGreaterThanOrEqual)\(/;

// By file and exact line, so an edited line is read again; the value says why a slow runner cannot fail it.
const ALLOWED = new Map([
  ['token-eval-z0-turns.test.ts: expect(wallMs + 10_000).toBeLessThanOrEqual(stepMs);', 'the bound is the same step\'s own span, taken in the same run, which a slow runner only widens'],
]);

/** The text between the bracket at `open` and the bracket that closes it. */
function inside(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return '';
}

/** Every assertion in `text` that bounds an elapsed time from above, as `file: line text`. */
function elapsedUpperBounds(file: string, text: string): string[] {
  const durations = [...text.matchAll(ASSIGNED)].map((m) => m[1]);
  const timed = (code: string): boolean => CLOCK_DIFF.test(code) || REPORTED.test(code)
    || durations.some((name) => new RegExp(String.raw`(?<![\w$.])${name.replaceAll('$', String.raw`\$`)}(?![\w$])`).test(code));
  const hits: string[] = [];
  for (const found of text.matchAll(/\bexpect\(/g)) {
    const open = found.index + found[0].length - 1;
    const subject = inside(text, open);
    const after = text.slice(open + subject.length + 2);
    const matcher = MATCHER.exec(after);
    if (subject !== '' && (matcher ? boundedByMatcher(subject, after, matcher, timed) : boundedInline(subject, timed))) {
      const line = text.slice(0, found.index).split('\n').length;
      hits.push(`${file}: ${text.split(/\r?\n/)[line - 1].trim()}`);
    }
  }
  return hits;
}

/** expect(elapsed).toBeLessThan(n), and its mirror expect(n).toBeGreaterThan(elapsed). */
function boundedByMatcher(subject: string, after: string, matcher: RegExpExecArray, timed: (code: string) => boolean): boolean {
  const upper = matcher[2].startsWith('toBeLess') !== (matcher[1] !== undefined);
  // The text before a comma is the value; after it comes the failure message.
  if (upper) return timed(subject.split(',')[0]);
  return timed(inside(after, matcher[0].length - 1)) && !timed(subject);
}

/** expect(elapsed < n).toBe(true): the smaller side of a comparison is the bounded one. */
function boundedInline(subject: string, timed: (code: string) => boolean): boolean {
  return subject.split(/&&|\|\|/).some((clause) => {
    const compared = /^(.*?)\s(<=?|>=?)\s(.*)$/s.exec(clause);
    return compared !== null && timed(compared[2].startsWith('<') ? compared[1] : compared[3]);
  });
}

const files = readdirSync(TESTS, { recursive: true, encoding: 'utf8' })
  .map((file) => file.split('\\').join('/'))
  .filter((file) => /\.(?:ts|mjs|cjs)$/.test(file) && !file.startsWith('fixtures/') && file !== SELF);
const found = files.flatMap((file) => elapsedUpperBounds(file, readFileSync(join(TESTS, file), 'utf8')));

describe('elapsed-time upper bounds in tests', () => {
  it('reads the whole tests folder, so the scan is live', () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it('no test asserts one outside the listed lines', () => {
    expect(found.filter((hit) => !ALLOWED.has(hit))).toEqual([]);
  });

  it('every listed line still exists and says why, so the list cannot hold a stale pass', () => {
    expect([...ALLOWED.keys()].filter((line) => !found.includes(line))).toEqual([]);
    expect([...ALLOWED.values()].filter((why) => why.trim().length < 20)).toEqual([]);
  });

  it.each([
    'const elapsed = Date.now() - started;\nexpect(elapsed).toBeLessThan(3000);',
    'expect(Date.now() - started).toBeLessThan(30_000);',
    'expect(performance.now() - t0, "too slow").toBeLessThanOrEqual(500);',
    'expect(run.elapsedMs).toBeLessThan(PROMPT_HOOK_BUDGET_MS);',
    'let took = 0;\ntook = performance.now() - t0;\nexpect(took).not.toBeGreaterThan(100);',
    'const stopElapsed = Date.now() - stopStart;\nexpect(5000).toBeGreaterThan(stopElapsed);',
    'const ms = Number(process.hrtime.bigint() - begin) / 1e6;\nexpect(ms < 250).toBe(true);',
    'expect(ok && LIMIT_MS >= child.durationMs).toBe(true);',
    'expect(\n  Date.now() - started,\n).toBeLessThan(2000);',
  ])('flags %j', (sample) => {
    expect(elapsedUpperBounds('x.test.ts', sample)).toHaveLength(1);
  });

  it.each([
    // A wait that must have happened.
    'const elapsed = Date.now() - started;\nexpect(elapsed).toBeGreaterThanOrEqual(3_500);',
    // A stored time bracketed by the clock: a slow runner only moves the later read further out.
    'expect(row.updatedAt).toBeLessThanOrEqual(Date.now());',
    'const cutoff = Date.now() - 30 * DAY_MS;\nexpect(row.ts).toBeLessThan(cutoff);',
    // A ratio of two timings taken in the same test.
    'const fast = performance.now() - t0;\nconst slow = performance.now() - t1;\nexpect(slow / fast > 0).toBe(true);\nconst growth = slow / fast;\nexpect(growth).toBeLessThan(20);',
    // A count, whatever it is called.
    'expect(retries).toBeLessThan(5);',
  ])('passes %j', (sample) => {
    expect(elapsedUpperBounds('x.test.ts', sample)).toEqual([]);
  });
});
