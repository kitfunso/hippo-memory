import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS = fileURLToPath(new URL('..', import.meta.url));
const UI_SRC = fileURLToPath(new URL('../../ui/src', import.meta.url));
const SELF = 'scripts/elapsed-time-upper-bounds.test.ts';
const CLOCK = String.raw`(?:Date\.now\(\)|performance\.now\(\)|hrtime(?:\.bigint)?\(\))`;
const CLOCK_DIFF = new RegExp(String.raw`${CLOCK}\s*-\s*[a-z_$][\w$.]*(?!\s*[*(/\w$.])`);
const ASSIGNED = new RegExp(String.raw`(?<![\w$.])([A-Za-z_$][\w$]*)\s*=[^=;\n]*?${CLOCK_DIFF.source}`, 'g');
const ASSIGNMENT = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*=(?![=>])([^;\n]*)/g;
const RATIO_NAME = /(?<![\w$])[\w$]*(?:[Rr]atio|[Gg]rowth|[Ss]lowdown)\b/;
const TIMING_RATIO_NAME =
  /(?<![\w$])[\w$]*(?:[Ff]astest|[Ss]lowest|[Tt]iming|[Tt]imed|[Ee]lapsed|[Dd]uration)[\w$]*(?:[Rr]atio|[Gg]rowth)\b/;
const REPORTED = /(?<![\w$])(?:elapsed|ms|[\w$]*(?:Ms|_ms))\b/;
const MATCHER = /^\s*\.\s*(not\s*\.\s*)?(toBeLessThan|toBeLessThanOrEqual|toBeGreaterThan|toBeGreaterThanOrEqual)\(/;

const ALLOWED = new Map([
  [
    'eval/token-eval-z0-turns-resume-limits-and-planted-files.test.ts: expect(wallMs + 10_000).toBeLessThanOrEqual(stepMs);',
    "the bound is the same step's own span, taken in the same run, which a slow runner only widens",
  ],
  [
    'eval/token-eval-z0-codex-faults.test.ts: expect(wallMs + waitMs).toBeLessThanOrEqual(stepMs);',
    "the bound is the same cell's own span, taken in the same run, which a slow runner only widens",
  ],
  [
    'store/company-brain-scorecard.test.ts: expect(report.p95Ms).toBeLessThanOrEqual(600 * 60 * 1000);',
    'the value is a percentile computed from fixture timestamps, not a measured wall-clock span, so a slow runner cannot change it',
  ],
]);

function inside(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return '';
}

function elapsedUpperBounds(file: string, text: string): string[] {
  const durations = [...text.matchAll(ASSIGNED)].map((m) => m[1]);
  const measuresTime = CLOCK_DIFF.test(text);
  const timed = (code: string): boolean =>
    CLOCK_DIFF.test(code) ||
    REPORTED.test(code) ||
    (measuresTime && RATIO_NAME.test(code)) ||
    TIMING_RATIO_NAME.test(code) ||
    durations.some((name) =>
      new RegExp(String.raw`(?<![\w$.])${name.replaceAll('$', String.raw`\$`)}(?![\w$])`).test(code),
    );
  const products = [...text.matchAll(ASSIGNMENT)].filter((m) => /[*/]/.test(m[2]) || TIMING_RATIO_NAME.test(m[2]));
  for (let grew = true; grew;) {
    grew = false;
    for (const [, name, value] of products) {
      if (!durations.includes(name) && timed(value)) {
        durations.push(name);
        grew = true;
      }
    }
  }
  const hits: string[] = [];
  for (const found of text.matchAll(/\bexpect\(/g)) {
    const open = found.index + found[0].length - 1;
    const subject = inside(text, open);
    const after = text.slice(open + subject.length + 2);
    const matcher = MATCHER.exec(after);
    if (
      subject !== '' &&
      (matcher ? boundedByMatcher(subject, after, matcher, timed) : boundedInline(subject, timed))
    ) {
      const line = text.slice(0, found.index).split('\n').length;
      hits.push(`${file}: ${text.split(/\r?\n/)[line - 1].trim()}`);
    }
  }
  return hits;
}

function boundedByMatcher(
  subject: string,
  after: string,
  matcher: RegExpExecArray,
  timed: (code: string) => boolean,
): boolean {
  const upper = matcher[2].startsWith('toBeLess') !== (matcher[1] !== undefined);
  if (upper) return timed(subject.split(',')[0]);
  return timed(inside(after, matcher[0].length - 1)) && !timed(subject);
}

function boundedInline(subject: string, timed: (code: string) => boolean): boolean {
  return subject.split(/&&|\|\|/).some((clause) => {
    const compared = /^(.*?)\s(<=?|>=?)\s(.*)$/s.exec(clause);
    return compared !== null && timed(compared[2].startsWith('<') ? compared[1] : compared[3]);
  });
}

const files = readdirSync(TESTS, { recursive: true, encoding: 'utf8' })
  .map((file) => file.split('\\').join('/'))
  .filter((file) => /\.(?:ts|mjs|cjs)$/.test(file) && !file.startsWith('fixtures/') && file !== SELF);
const uiFiles = readdirSync(UI_SRC, { recursive: true, encoding: 'utf8' })
  .map((file) => file.split('\\').join('/'))
  .filter((file) => /\.test\.tsx?$/.test(file));
const found = [
  ...files.flatMap((file) => elapsedUpperBounds(file, readFileSync(join(TESTS, file), 'utf8'))),
  ...uiFiles.flatMap((file) => elapsedUpperBounds(`ui/src/${file}`, readFileSync(join(UI_SRC, file), 'utf8'))),
];

describe('elapsed-time upper bounds in tests', () => {
  it('reads the whole tests folder, so the scan is live', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(uiFiles.length).toBeGreaterThan(5);
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
    'expect(t.wait.ms).toBeLessThan(5000);',
    'expect(res.latencyMs).toBeLessThanOrEqual(200);',
    'expect(run.elapsedMs).toBeLessThan(PROMPT_HOOK_BUDGET_MS);',
    'let took = 0;\ntook = performance.now() - t0;\nexpect(took).not.toBeGreaterThan(100);',
    'const stopElapsed = Date.now() - stopStart;\nexpect(5000).toBeGreaterThan(stopElapsed);',
    'const ms = Number(process.hrtime.bigint() - begin) / 1e6;\nexpect(ms < 250).toBe(true);',
    'expect(ok && LIMIT_MS >= child.durationMs).toBe(true);',
    'expect(\n  Date.now() - started,\n).toBeLessThan(2000);',
    'const fast = performance.now() - t0;\nconst slow = performance.now() - t1;\nconst growth = slow / fast;\nexpect(growth).toBeLessThan(20);',
    'const ratio = a.elapsedMs / b.elapsedMs;\nexpect(ratio).toBeLessThan(4);',
    'const total = perCallMs * calls;\nexpect(total).toBeLessThan(1000);',
    'const took = performance.now() - t0;\nconst ratio = fastestRatio(crafted, prose);\nexpect(ratio).toBeLessThan(50);',
    'const took = performance.now() - t0;\nconst slowdown = slow / fast;\nexpect(5).toBeGreaterThan(slowdown);',
    'const ratio = fastestRatio(crafted, prose);\nexpect(ratio, "x").toBeLessThan(50);',
  ])('flags %j', (sample) => {
    expect(elapsedUpperBounds('x.test.ts', sample)).toHaveLength(1);
  });

  it.each([
    'const elapsed = Date.now() - started;\nexpect(elapsed).toBeGreaterThanOrEqual(3_500);',
    'expect(row.updatedAt).toBeLessThanOrEqual(Date.now());',
    'const cutoff = Date.now() - 30 * DAY_MS;\nexpect(row.ts).toBeLessThan(cutoff);',
    'const fast = performance.now() - t0;\nconst slow = performance.now() - t1;\nexpect(slow / fast > 0).toBe(true);',
    'expect(compressionRatio).toBeLessThan(0.5);',
    'const growth = after.rows / before.rows;\nexpect(growth).toBeLessThan(4);',
    'expect(after.rowsRead).toBeLessThanOrEqual(MAX_GROWTH * before.rowsRead);',
    'expect(retries).toBeLessThan(5);',
  ])('passes %j', (sample) => {
    expect(elapsedUpperBounds('x.test.ts', sample)).toEqual([]);
  });
});
