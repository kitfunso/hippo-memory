// Z0 session timeouts with the fake Claude Code (prereg 165): a graded record priced from its transcript, never a plan limit.
// Costs nothing; each HANG waits out a short session timeout.
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { transcriptUsage, assistantTurns } from '../scripts/token-eval/records.mjs';
import { validateCorpus } from './fixtures/z0-contract';
import {
  cleanup, tmp, isolate, makeRepo, task, plain, oneLesson, spec, run, readRecords, readPlan, rawResult, logLines, find,
} from './fixtures/z0-harness';

afterEach(cleanup);

const TIMEOUT = { sessionTimeoutMs: 5000 };
const ZERO = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ESRCH') return false;
    throw err;
  }
}

describe('transcript pricing', () => {
  it('takes the largest value per bucket per message id, then sums over ids; a byte range prices one turn', () => {
    const f = join(tmp('z0-timeout-usage-'), 's.jsonl');
    const line = (id: string, out: number, input = 10) => JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: input, output_tokens: out, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } } });
    const first = [JSON.stringify({ type: 'user', message: { content: 'x' } }), line('m1', 5), line('m1', 40), line('m2', 7, 3)].join('\n');
    writeFileSync(f, `${first}\n${line('m3', 9)}`);
    expect(transcriptUsage([{ file: f, toBytes: first.length }])).toEqual({ inputTokens: 13, cacheWriteTokens: 40, cacheReadTokens: 200, outputTokens: 47 });
    expect(assistantTurns([{ file: f, toBytes: first.length }])).toBe(2);
    expect(transcriptUsage([{ file: f, fromBytes: first.length }])).toMatchObject({ outputTokens: 9 });
    expect(transcriptUsage([{ file: join(f, '..', 'missing.jsonl') }])).toEqual(ZERO);
  });
});

describe('a session that runs out of time (prereg 165)', () => {
  it('is a valid, unresolved record priced from its transcript, with no cost', async () => {
    const { out } = isolate('hang');
    const r = makeRepo();
    await run(spec(r, [], [task(r, 'n1', 'HANG'), plain(r, 'n2')]), ['A0'], out, TIMEOUT);
    const recs = readRecords(out);
    const n1 = find(recs, 'A0', 'n1');
    expect(n1).toMatchObject({ invalid: null, timedOut: true, resolved: false, costUsd: null, turns: 2, turnsSource: 'transcript', transcriptFound: true });
    expect(n1.usage!.firstSession).toEqual({ inputTokens: 13, cacheWriteTokens: 40, cacheReadTokens: 200, outputTokens: 47 });
    expect(n1.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(find(recs, 'A0', 'n2')).toMatchObject({ invalid: null, timedOut: false, turnsSource: 'result' });
    expect(validateCorpus(recs, readPlan(out))).toEqual([]);
  }, 120_000);

  it('a timed-out teach is still checked and resumed, and A4 is taught from its resume', async () => {
    const { out, log } = isolate('hang-teach');
    const r = makeRepo();
    await run(oneLesson(r, { t1: 'HANG LESSON_BAD' }), ['A4'], out, TIMEOUT);
    const recs = readRecords(out);
    const t1 = find(recs, 'A4', 't1');
    expect(t1).toMatchObject({ invalid: null, timedOut: true, resolved: false, teachTurns: 1, teachForm: 'correction', lessons: [{ lessonId: 'f1-l1', first: 'fail', final: 'pass' }] });
    expect(logLines(log)).toContain(`resume ${t1.sessionId}`);
    expect(t1.usage!.extra.outputTokens).toBeGreaterThan(0);
    expect(rawResult(out, 'A4', 'n1.json').files['CLAUDE.md']).toContain('- Write the lesson file, because');
    expect(validateCorpus(recs, readPlan(out))).toEqual([]);
  }, 120_000);

  it('a resume that runs out of time is graded, not invalid: resume, and priced from its own bytes', async () => {
    const { out } = isolate('hang-resume');
    const r = makeRepo();
    await run(oneLesson(r, { t1: 'LESSON_BAD HANG_ON_RESUME' }), ['A4'], out, TIMEOUT);
    const recs = readRecords(out);
    const t1 = find(recs, 'A4', 't1');
    expect(t1).toMatchObject({ invalid: null, timedOut: true, resolved: false, costUsd: null, turnsSource: 'transcript', lessons: [{ first: 'fail', final: 'fail' }] });
    expect(t1.usage!.extra).toEqual({ inputTokens: 13, cacheWriteTokens: 40, cacheReadTokens: 200, outputTokens: 47 });
    expect(t1.usage!.firstSession.outputTokens).toBe(50);
    // The hung resume's transcript grew past the teach message, so A4 counts the lesson as told (decision 7).
    expect(rawResult(out, 'A4', 'n1.json').files['CLAUDE.md']).toContain('- Write the lesson file, because');
  }, 120_000);

  it('a resume that bills into a subagent file session 1 wrote prices those bytes as the resume\'s', async () => {
    const { out } = isolate('hang-resume-sub');
    const r = makeRepo();
    await run(oneLesson(r, { t1: 'LESSON_BAD HANG_ON_RESUME RESUME_SUBAGENT_USAGE\nSUBAGENT_CMD echo hi' }), ['A4'], out, TIMEOUT);
    const t1 = find(readRecords(out), 'A4', 't1');
    expect(t1).toMatchObject({ invalid: null, timedOut: true, turnsSource: 'transcript' });
    expect(t1.usage!.extra).toEqual({ inputTokens: 13, cacheWriteTokens: 40, cacheReadTokens: 200, outputTokens: 1047 });
  }, 300_000);

  it('a hung session whose stderr says overloaded_error is a timeout, never a plan-limit wait', async () => {
    const { out } = isolate('hang-overload');
    const r = makeRepo();
    await run(spec(r, [], [task(r, 'n1', 'HANG_STDERR'), plain(r, 'n2')]), ['A0'], out, { ...TIMEOUT, limitWaitMs: 600_000 });
    expect(find(readRecords(out), 'A0', 'n1')).toMatchObject({ invalid: null, limitRetries: 0, timedOut: true });
    expect(readdirSync(join(out, 'raw', 'seqF', 'A0', 'seed1')).filter((f) => f.includes('limit'))).toEqual([]);
  }, 60_000);

  it('a timeout kills the agent and every process under it', async () => {
    const { out } = isolate('hang-tree');
    const r = makeRepo();
    const started = Date.now();
    await run(spec(r, [], [task(r, 'n1', 'HANG'), plain(r, 'n2')]), ['A0'], out, TIMEOUT);
    // Well under the fake's 120 s hang, which a run that waited on the tree would sit out; loose for a loaded box.
    expect(Date.now() - started).toBeLessThan(90_000);
    const tick = join(out, 'tick.txt');
    expect(existsSync(tick)).toBe(true);
    const pid = Number(readFileSync(join(out, 'grandchild.pid'), 'utf8'));
    try {
      const before = statSync(tick).size;
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(statSync(tick).size).toBe(before);
      expect(alive(pid)).toBe(false);
    } finally {
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
  }, 110_000);

  it('a timeout with no transcript stays invalid: no-transcript', async () => {
    const { out } = isolate('hang-none');
    const r = makeRepo();
    await run(spec(r, [], [task(r, 'n1', 'HANG NOTRANSCRIPT'), plain(r, 'n2')]), ['A0'], out, TIMEOUT);
    expect(find(readRecords(out), 'A0', 'n1')).toMatchObject({ invalid: 'no-transcript', timedOut: true, usage: null });
  }, 60_000);
});
