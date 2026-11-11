// Round 4 slice 2b, the runner's half of the Ledger: cut-off copies under <out>/cutoffs, and hookCancels on every session record.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as abRun from '../scripts/token-eval/ab-run.mjs';
import { DESIGNS } from '../scripts/token-eval/arms.mjs';
import { runCli as hookhold } from '../scripts/token-eval/z0-hookhold.mjs';
import { startStubUpstream } from '../scripts/token-eval/proxy.mjs';
import { cleanup, tmp, isolate, makeRepo, family, lesson, task, teach, apply, plain, spec, oneLesson, run, logLines, fixtureEnv, type FixtureRepo } from './fixtures/z0-harness.js';
import { PRICES_BY_MODEL } from './fixtures/z0-gen.js';

const BUILD = { hippoCommit: 'c'.repeat(40), hippoDirty: false, hippoDistHash: 'd'.repeat(64) };
const TOKEN = 'fake-tok-cutoff';
const R4 = DESIGNS.r4.arms;
const FAKE_AGENT = resolve(__dirname, 'fixtures', 'fake-claude.mjs');
const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
beforeEach(() => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = TOKEN;
});
afterEach(() => {
  cleanup();
  delete process.env.FAKE_CLAUDE_LIMIT_ONCE;
  if (savedToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
});

const jsonl = <T>(file: string): T[] => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const filesUnder = (dir: string, rel = ''): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((f) => {
  const child = rel ? `${rel}/${f}` : f;
  return statSync(join(dir, f)).isDirectory() ? filesUnder(join(dir, f), child) : [child];
}).sort() : []);

interface Knobs { file: string; cmd: string }
function knobs(): Knobs {
  const dir = tmp('r4-cutoff-knobs-');
  const prices = join(dir, 'prices.json');
  writeFileSync(prices, JSON.stringify(PRICES_BY_MODEL));
  const usage = { input: 1000, output: 2000, cacheRead: 50_000, cacheWrite: 4000 };
  const file = join(dir, 'knobs.json');
  writeFileSync(file, JSON.stringify({
    schema: 'z0-fake-knobs/1', token: TOKEN, calls: join(dir, 'calls.jsonl'), prices, version: '9.9.9', usage: Object.fromEntries(R4.map((a: string) => [a, usage])),
    effortScale: { low: 0.5, medium: 1, high: 2 }, outcome: Object.fromEntries(R4.map((a: string) => [a, { lesson: 0.5, solve: 0.5 }])), leaks: [], offPin: [], fail: [], warmupFail: [],
  }));
  return { file, cmd: `"${process.execPath}" "${FAKE_AGENT}" --fake-knobs "${file}"` };
}

/** The fake agent behind a wrapper that (a) cuts the first session it sees at the plan limit after writing a transcript line under its --session-id, once,
 * and (b) appends hook_cancelled attachments to a first session's transcript for the CANCEL_* prompt markers. */
function wrapper(k: Knobs, { cutFirst = false } = {}) {
  const dir = tmp('r4-cutoff-agent-');
  const once = join(dir, 'cut-once');
  writeFileSync(join(dir, 'agent.mjs'), [
    "import { spawnSync } from 'node:child_process';", "import * as fs from 'node:fs';", "import * as path from 'node:path';",
    'const argv = process.argv.slice(2);',
    "const input = fs.readFileSync(0, 'utf8');",
    "const first = argv.includes('--settings') && !argv.includes('--resume') && argv.includes('--session-id');",
    "const folder = process.cwd().replace(/[^a-zA-Z0-9]/g, '-');",
    "const main = first ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', folder, `${argv[argv.indexOf('--session-id') + 1]}.jsonl`) : null;",
    `if (${cutFirst} && first && !fs.existsSync(${JSON.stringify(once)})) {`,
    `  fs.writeFileSync(${JSON.stringify(once)}, '');`,
    '  fs.mkdirSync(path.dirname(main), { recursive: true });',
    "  fs.writeFileSync(main, JSON.stringify({ type: 'user', message: { role: 'user', content: input } }));",
    "  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|1790000000' }));",
    '  process.exit(1);',
    '}',
    `const r = spawnSync(process.execPath, [${JSON.stringify(FAKE_AGENT)}, '--fake-knobs', ${JSON.stringify(k.file)}, ...argv], { input, encoding: 'utf8', env: process.env });`,
    "process.stdout.write(r.stdout ?? '');",
    "process.stderr.write(r.stderr ?? '');",
    'if (first && r.status === 0) {',
    "  const attach = (a) => JSON.stringify({ type: 'attachment', attachment: a });",
    '  const lines = [];',
    "  if (input.includes('CANCEL_EVENT')) lines.push(attach({ type: 'hook_cancelled', hookEvent: 'UserPromptSubmit' }));",
    "  if (input.includes('CANCEL_NAME')) lines.push(attach({ type: 'hook_cancelled', hookName: 'PreToolUse:Bash' }));",
    "  if (input.includes('CANCEL_BARE')) lines.push(attach({ type: 'hook_cancelled' }));",
    "  if (input.includes('CANCEL_JUNK')) lines.push('not json at all', attach({ type: 'hook_success', hookEvent: 'UserPromptSubmit' }));",
    "  if (lines.length) fs.appendFileSync(main, `\\n${lines.join('\\n')}`);",
    '}',
    'process.exit(r.status ?? 1);',
  ].join('\n'));
  return `"${process.execPath}" "${join(dir, 'agent.mjs')}"`;
}

interface Extra { limitWaitMs?: number }
/** runAll under r4 with a stub upstream, so a request from the fake never leaves the machine. */
async function r4run(s: ReturnType<typeof spec>, arms: string[], out: string, agent: string, extra: Extra = {}) {
  mkdirSync(out, { recursive: true });
  const stub = await startStubUpstream(join(out, 'stub.jsonl'));
  try {
    return await abRun.runAll({
      spec: s, arms, seeds: 1, outDir: out, model: null, claudeBin: agent, settleMs: 0, warmup: false, log: () => {}, passEnv: fixtureEnv(), design: DESIGNS.r4, effort: 'medium', upstream: stub.url, hippoBuild: BUILD, ...extra,
    });
  } finally {
    await stub.close();
  }
}

interface Wire { taskId: string; arm: string; invalid: string | null; sessionId: string | null; limitRetries: number; void: string | null; voidHits?: { class: string | null }[]; surfaceRestored?: boolean; hookCancels?: Record<string, number> }
const wire = (out: string): Wire[] => jsonl<Wire>(join(out, 'runs.jsonl'));
interface Attempt { taskId: string; kind: string; attempt: number; sessionId: string; sizesBefore: Record<string, number> | null }
const attemptsOf = (out: string, arm: string) => jsonl<Attempt>(join(out, 'raw', 'seqF', arm, 'seed1', 'attempts.jsonl'));
const cutoffsOf = (out: string, arm = 'S1') => join(out, 'cutoffs', 'seqF', arm, 'seed1');
const configOf = (out: string, arm = 'S1') => join(out, 'runs', 'seqF', arm, 'seed1', 'claude-config');

/** t1 teaches (its resume is cut off), n1 reads the copy folder, then two more plain tasks and two applies. */
function cutSpec(r: FixtureRepo, t1: string, n1 = 'look around only') {
  return spec(r, [family('f1', [lesson('f1-l1', 'Write the lesson file')])], [
    teach(r, 't1', 'f1-l1', t1), task(r, 'n1', n1), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'look around only'), apply(r, 'a2', 'f1-l1', 'look around only'),
  ]);
}

describe('cut-off copies under round 4', () => {
  it('a cut-off resume leaves its main and subagent transcripts at their claude-config paths and attempt.json, and the live copies are restored', async () => {
    const { out } = isolate('r4-cutoff-copy');
    await r4run(cutSpec(makeRepo(), 'CUT_ON_RESUME CUT_SUBAGENT LESSON_BAD'), ['S1'], out, knobs().cmd, { limitWaitMs: 0 });
    const records = wire(out);
    const t1 = records.find((x) => x.taskId === 't1')!;
    expect(t1).toMatchObject({ invalid: null, limitRetries: 1 });
    expect(readdirSync(cutoffsOf(out))).toEqual(['0-1']);
    const copy = join(cutoffsOf(out), '0-1');
    const files = filesUnder(copy);
    const sub = files.find((f) => f.endsWith('/subagents/agent-cut.jsonl'))!;
    const main = files.find((f) => f.endsWith(`${t1.sessionId}.jsonl`) && !f.includes('/subagents/'))!;
    expect(files).toEqual(['attempt.json', main, sub].sort());
    expect(main).toMatch(/^projects\/[^/]+\/[^/]+\.jsonl$/);
    expect(sub).toBe(`${main.replace(/\.jsonl$/, '')}/subagents/agent-cut.jsonl`);
    expect(readFileSync(join(copy, ...main.split('/')), 'utf8')).toContain('echo cut-off turn');
    expect(readFileSync(join(copy, ...sub.split('/')), 'utf8')).toContain('echo cut-off subagent');
    const attempt = JSON.parse(readFileSync(join(copy, 'attempt.json'), 'utf8'));
    expect(Object.keys(attempt).sort()).toEqual(['attempt', 'sessionId', 'sizesBefore', 'taskId']);
    expect(attempt).toMatchObject({ taskId: 't1', attempt: 1, sessionId: t1.sessionId });
    const resumes = attemptsOf(out, 'S1').filter((l) => l.taskId === 't1' && l.kind === 'resume');
    expect(resumes.map((l) => l.attempt)).toEqual([1, 2]);
    expect(attempt.sizesBefore).toEqual(resumes[0]!.sizesBefore);
    expect(Object.keys(attempt.sizesBefore).length).toBeGreaterThanOrEqual(1);
    // The runner put the live files back before the rerun: no subagent file of the cut-off, no cut-off turn in the live transcript.
    const live = join(configOf(out), ...main.split('/'));
    expect(existsSync(live)).toBe(true);
    expect(readFileSync(live, 'utf8')).not.toContain('echo cut-off turn');
    expect(filesUnder(configOf(out)).filter((f) => f.endsWith('agent-cut.jsonl'))).toEqual([]);
  }, 180_000);

  it('a later session that reads a file under <out>/cutoffs is void other-run', async () => {
    const { out } = isolate('r4-cutoff-read');
    await r4run(cutSpec(makeRepo(), 'CUT_ON_RESUME LESSON_BAD', 'READ:{OUT}/cutoffs/seqF/S1/seed1/0-1/attempt.json'), ['S1'], out, knobs().cmd, { limitWaitMs: 0 });
    expect(existsSync(join(cutoffsOf(out), '0-1', 'attempt.json'))).toBe(true);
    const records = wire(out);
    const read = (id: string) => records.find((x) => x.taskId === id)!;
    expect([read('n1').invalid, read('n1').void, (read('n1').voidHits ?? []).map((h) => h.class)]).toEqual([null, 'read', ['other-run']]);
    expect([read('t1').invalid, read('t1').void]).toEqual([null, null]);
  }, 180_000);

  it('takes the smallest k whose folder does not exist, and leaves an existing one alone', async () => {
    const { out } = isolate('r4-cutoff-k');
    mkdirSync(join(cutoffsOf(out), '0-1'), { recursive: true });
    writeFileSync(join(cutoffsOf(out), '0-1', 'keep.txt'), 'older\n');
    await r4run(oneLesson(makeRepo(), { t1: 'CUT_ON_RESUME LESSON_BAD' }), ['S1'], out, knobs().cmd, { limitWaitMs: 0 });
    expect(readdirSync(cutoffsOf(out)).sort()).toEqual(['0-1', '0-2']);
    expect(filesUnder(join(cutoffsOf(out), '0-1'))).toEqual(['keep.txt']);
    expect(filesUnder(join(cutoffsOf(out), '0-2'))).toContain('attempt.json');
    expect(JSON.parse(readFileSync(join(cutoffsOf(out), '0-2', 'attempt.json'), 'utf8'))).toMatchObject({ taskId: 't1', attempt: 1 });
  }, 180_000);

  it('a cut-off first session keeps its transcript under its own id and makes no copy', async () => {
    const { out } = isolate('r4-cutoff-first');
    const r = makeRepo();
    await r4run(spec(r, [], [plain(r, 'p1'), plain(r, 'p2')]), ['S1'], out, wrapper(knobs(), { cutFirst: true }), { limitWaitMs: 0 });
    const sessions = attemptsOf(out, 'S1').filter((l) => l.taskId === 'p1' && l.kind === 'session');
    expect(sessions.map((l) => l.attempt)).toEqual([1, 2]);
    const [cut, kept] = sessions.map((l) => l.sessionId);
    expect(cut).not.toBe(kept);
    const cutFile = filesUnder(configOf(out)).find((f) => f.endsWith(`${cut}.jsonl`))!;
    expect(cutFile).toBeTruthy();
    expect(readFileSync(join(configOf(out), ...cutFile.split('/')), 'utf8')).toContain('look around only');
    expect(wire(out).find((x) => x.taskId === 'p1')).toMatchObject({ invalid: null, limitRetries: 1, sessionId: kept });
    expect(existsSync(join(out, 'cutoffs'))).toBe(false);
  }, 180_000);

  it('under r3 a cut-off resume writes no cutoffs folder and no hookCancels', async () => {
    const { out, log } = isolate('r3-cutoff');
    await run(oneLesson(makeRepo(), { t1: 'CUT_ON_RESUME CUT_SUBAGENT LESSON_BAD' }), ['A1'], out, { limitWaitMs: 0 });
    expect(logLines(log)).toContain('cutoff-written');
    expect(existsSync(join(out, 'cutoffs'))).toBe(false);
    const sessions = wire(out).filter((x) => 'surfaceRestored' in x);
    expect(sessions.length).toBeGreaterThanOrEqual(5);
    for (const x of sessions) expect(x, x.taskId).not.toHaveProperty('hookCancels');
  }, 180_000);
});

describe('hookCancels on session records under round 4', () => {
  it('counts hook_cancelled attachments per event on every session record, keys an unnamed one unknown, and feeds z0-hookhold', async () => {
    const { out } = isolate('r4-hookcancels');
    const r = makeRepo();
    const s = spec(r, [family('f1', [lesson('f1-l1', 'Write the lesson file')])], [
      teach(r, 't1', 'f1-l1', 'LESSON_OK'), task(r, 'n1', 'CANCEL_NAME\nCANCEL_BARE\nCANCEL_JUNK'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'LESSON_BAD\nCANCEL_EVENT'), apply(r, 'a2', 'f1-l1', 'LESSON_OK'),
    ]);
    await r4run(s, ['S1', 'S2'], out, wrapper(knobs()));
    const records = wire(out);
    // The sessions are listed by the producer's own marker, and a missing field fails the test.
    const sessions = records.filter((x) => 'surfaceRestored' in x);
    expect(sessions.map((x) => `${x.arm}/${x.taskId}`).sort()).toEqual(['S1', 'S2'].flatMap((a) => ['a1', 'a2', 'n1', 'n2', 't1'].map((id) => `${a}/${id}`)));
    for (const x of sessions) {
      expect(x, `${x.arm}/${x.taskId}`).toHaveProperty('hookCancels');
      expect(x.hookCancels!.constructor, `${x.arm}/${x.taskId}`).toBe(Object);
    }
    for (const arm of ['S1', 'S2']) {
      const of = (id: string) => sessions.find((x) => x.arm === arm && x.taskId === id)!.hookCancels;
      expect(of('t1')).toEqual({});
      expect(of('n1')).toEqual({ 'PreToolUse:Bash': 1, unknown: 1 });
      expect(of('a1')).toEqual({ UserPromptSubmit: 1 });
      expect(of('a2')).toEqual({});
      expect(of('n2')).toEqual({});
    }
    const list = join(tmp('r4-hookcancels-list-'), 'hook.json');
    const res = hookhold(['--design', 'r4', '--runs', join(out, 'runs.jsonl'), '--sensitivity', list]);
    expect(res.code, res.stderr).toBe(0);
    expect(JSON.parse(readFileSync(list, 'utf8')).hookVoids).toEqual([{ sequence: 'seqF', seed: 1, position: 3 }]);
  }, 300_000);

  it('is {} when a session has no session id to read, and a setup failure writes no session fields', async () => {
    const { out } = isolate('r4-hookcancels-none');
    const r = makeRepo();
    const s = spec(r, [], [task(r, 'p1', 'NO_SESSION_ID'), task(r, 'p2', 'look around only', { setup: `"${process.execPath}" -e "process.exit(1)"` })]);
    await r4run(s, ['S1'], out, knobs().cmd);
    const records = wire(out);
    expect(records.map((x) => [x.taskId, x.invalid])).toEqual([['p1', 'no-transcript'], ['p2', 'setup']]);
    expect(records[0]!.hookCancels).toEqual({});
    expect(records[1]).not.toHaveProperty('hookCancels');
  }, 120_000);
});
