// Instruction files the agent leaves above work/, and usage limits around resumes.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { stubBaseCommit, STUB_CLAUDE_MD } from '../../scripts/token-eval/workspace.mjs';
import { isolate, type FixtureRepo, makeRepo, lesson, family, task, teach, apply, plain, spec, run, readRecords, logLines, checkLog, seen, find, workDir, expectInvalid, cleanup } from '../fixtures/z0-turns-harness.js';

afterEach(cleanup);

describe('an instruction file the agent leaves above work/', () => {
  const resumes = (log: string) => logLines(log).filter((l) => l.startsWith('resume ') && !l.startsWith('resume-'));
  const a4Md = (out: string) => readFileSync(join(workDir(out, 'A4'), 'CLAUDE.md'), 'utf8');
  const fam = () => family('f1', [lesson('f1-l1', 'Write the lesson file')]);

  it('voids an apply whatever its first check says', async () => {
    for (const first of ['LESSON_OK', 'LESSON_BAD']) {
      const { out, log } = isolate(`anc-apply-${first}`);
      const r = makeRepo();
      await run(spec(r, [fam()], [teach(r, 't1', 'f1-l1', 'LESSON_OK'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', `${first} ESCAPE`), apply(r, 'a2', 'f1-l1', 'LESSON_OK')]), ['A4'], out);
      const recs = readRecords(out);
      expectInvalid(find(recs, 'A4', 'a1'), 'ancestor-instructions');
      expect(resumes(log).filter((l) => l === `resume ${find(recs, 'A4', 'a1').sessionId}`), first).toEqual([]);
      expect(find(recs, 'A4', 'a2').invalid).toBe('ancestor-instructions');
    }
  }, 300_000);

  it('a teach that plants one takes no resume and A4 is not taught', async () => {
    const { out, log } = isolate('anc-teach');
    const r = makeRepo();
    await run(spec(r, [fam()], [teach(r, 't1', 'f1-l1', 'LESSON_OK ESCAPE'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'LESSON_OK'), apply(r, 'a2', 'f1-l1', 'LESSON_OK')]), ['A4'], out);
    expect(resumes(log)).toEqual([]);
    expect(a4Md(out)).not.toContain('Write the lesson file');
    expectInvalid(find(readRecords(out), 'A4', 't1'), 'ancestor-instructions');
  }, 300_000);

  it('one a cut-off resume plants stops the rerun, keeps the retry count, and A4 is not taught', async () => {
    const { out, log } = isolate('anc-cut');
    const r = makeRepo();
    await run(spec(r, [fam()], [teach(r, 't1', 'f1-l1', 'LESSON_BAD CUT_ON_RESUME ANCESTOR_ON_CUT'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'LESSON_OK'), apply(r, 'a2', 'f1-l1', 'LESSON_OK')]), ['A4'], out, { limitWaitMs: 0 });
    const t1 = find(readRecords(out), 'A4', 't1');
    expectInvalid(t1, 'ancestor-instructions');
    expect(t1.limitRetries).toBe(1);
    expect(resumes(log)).toEqual([`resume ${t1.sessionId}`]);
    expect(a4Md(out)).not.toContain('Write the lesson file');
    expect(existsSync(join(out, 'raw', 'seqF', 'A4', 'seed1', 't1.ancestor.txt'))).toBe(true);
  }, 300_000);

  it('a clean filter the agent set never runs when the runner snapshots for the check, so the cell grades normally', async () => {
    const { out, log } = isolate('anc-filter');
    const r = makeRepo();
    await run(spec(r, [fam()], [teach(r, 't1', 'f1-l1', 'LESSON_BAD CLEAN_FILTER_PLANT'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'LESSON_OK'), apply(r, 'a2', 'f1-l1', 'LESSON_OK')]), ['A4'], out);
    expect(existsSync(join(workDir(out, 'A4'), '..', 'CLAUDE.md'))).toBe(false);
    const recs = readRecords(out);
    const t1 = find(recs, 'A4', 't1');
    expect(t1).toMatchObject({ invalid: null, lessons: [{ first: 'fail', final: 'pass' }] });
    expect(resumes(log)).toEqual([`resume ${t1.sessionId}`]);
    expect(find(recs, 'A4', 'a1').invalid).toBeNull();
  }, 300_000);

  it('one a checker writes is caught right before the resume: no resume, and A4 is not taught', async () => {
    const { out, log } = isolate('anc-checker');
    const r = makeRepo();
    const escaping = family('f1', [lesson('f1-l1', 'Write the lesson file', { check: { script: 'lesson.mjs', args: ['escape'] } })]);
    await run(spec(r, [escaping], [teach(r, 't1', 'f1-l1', 'LESSON_BAD'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'LESSON_OK'), apply(r, 'a2', 'f1-l1', 'LESSON_OK')]), ['A4'], out);
    expectInvalid(find(readRecords(out), 'A4', 't1'), 'ancestor-instructions');
    expect(resumes(log)).toEqual([]);
    expect(a4Md(out)).not.toContain('Write the lesson file');
  }, 300_000);

  it('one a checker writes after a passing apply voids that apply, though it takes no resume', async () => {
    const { out } = isolate('anc-checker-pass');
    const r = makeRepo();
    const escaping = family('f1', [lesson('f1-l1', 'Write the lesson file', { check: { script: 'lesson.mjs', args: ['escape-if=trigger.txt'] } })]);
    await run(spec(r, [escaping], [teach(r, 't1', 'f1-l1', 'LESSON_OK'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'LESSON_OK NEW_FILE trigger.txt'), apply(r, 'a2', 'f1-l1', 'LESSON_OK')]), ['A1'], out);
    const recs = readRecords(out);
    expect(find(recs, 'A1', 't1').invalid).toBeNull();
    expectInvalid(find(recs, 'A1', 'a1'), 'ancestor-instructions');
  }, 300_000);
});


describe('usage limits around resumes', () => {
  const limitSpec = (r: FixtureRepo, extra: string) => spec(r, [family('f1', [lesson('f1-l1', 'Write the lesson file', { check: { script: 'lesson.mjs', args: ['probe'] } })])], [
    teach(r, 't1', 'f1-l1', `LESSON_BAD CUT_ON_RESUME COMMIT_ON_RESUME STAGE_EDIT a.txt NEW_FILE kept.txt${extra}`), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'look around only'), apply(r, 'a2', 'f1-l1', 'look around only'),
  ]);

  for (const variant of ['detached', 'branch']) {
    it(`a cut-off resume puts back the post-session-1 state exactly and reruns from the same session (${variant} HEAD)`, async () => {
      const { out, log } = isolate(`cut-${variant}`);
      const r = makeRepo();
      await run(limitSpec(r, `${variant === 'branch' ? ' ON_BRANCH' : ''} CUT_SUBAGENT`), ['A0'], out, { limitWaitMs: 0 });
      const t1 = find(readRecords(out), 'A0', 't1');
      expect(t1).toMatchObject({ invalid: null, limitRetries: 1, resumeSessionId: t1.sessionId, lessons: [{ first: 'fail', final: 'pass' }] });
      const lines = logLines(log);
      expect(lines.filter((l) => l === 'cutoff-written')).toHaveLength(1);
      expect(lines.filter((l) => l.startsWith('resume ') && !l.startsWith('resume-'))).toEqual([`resume ${t1.sessionId}`, `resume ${t1.sessionId}`]);
      const bytes = lines.filter((l) => l.startsWith('transcript-bytes '));
      expect(bytes).toHaveLength(2);
      expect(bytes[0]).toBe(bytes[1]);
      expect(existsSync(join(out, 'raw', 'seqF', 'A0', 'seed1', 't1.resume-limit1.txt'))).toBe(true);
      const final = checkLog(log)[1];
      expect(final).toMatchObject({
        head: t1.baseCommit, cutoffOnDisk: false, cutoffStaged: false, cachedStatus: 0, stagedA: 'v1', diskA: 'v2', kept: true,
        claudeMd: STUB_CLAUDE_MD, cutCommitAlive: false, preRef: final.pre,
      });
      expect(final.commands).not.toContain('echo cut-off subagent');
      expect(final.logAll).not.toContain('cutoff');
      expect(final.reflog ?? '').not.toContain('cutoff');
      expect(final.refs).not.toContain('refs/z0/resume-snap');
      if (variant === 'branch') expect(final).toMatchObject({ symbolic: 'refs/heads/work', work: t1.baseCommit });
      else expect(final.symbolic).toBeNull();
    }, 300_000);
  }

  it('restoring after a cut-off resume runs no smudge filter the agent set', async () => {
    const { out } = isolate('cut-smudge');
    const r = makeRepo();
    const s = spec(r, [family('f1', [lesson('f1-l1', 'Write the lesson file')])], [
      teach(r, 't1', 'f1-l1', 'LESSON_BAD CUT_ON_RESUME SMUDGE_FILTER'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'look around only'), apply(r, 'a2', 'f1-l1', 'look around only'),
    ]);
    await run(s, ['A0'], out, { limitWaitMs: 0 });
    expect(find(readRecords(out), 'A0', 't1')).toMatchObject({ invalid: null, limitRetries: 1, lessons: [{ first: 'fail', final: 'pass' }] });
    expect(existsSync(join(workDir(out, 'A0'), '..', 'smudge-ran.txt'))).toBe(false);
  }, 300_000);

  it('wallMs leaves out a cut-off resume attempt, its wait and its reset', async () => {
    const { out } = isolate('wall');
    const r = makeRepo();
    const s = spec(r, [family('f1', [lesson('f1-l1', 'Write the lesson file')])], [
      teach(r, 't1', 'f1-l1', 'LESSON_BAD CUT_ON_RESUME CUT_SLEEP_MS=5000'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'look around only'), apply(r, 'a2', 'f1-l1', 'look around only'),
    ]);
    await run(s, ['A0'], out, { limitWaitMs: 5000 });
    const t1 = find(readRecords(out), 'A0', 't1');
    expect(t1).toMatchObject({ invalid: null, limitRetries: 1, lessons: [{ first: 'fail', final: 'pass' }] });
    // t1's step spans its start to n1's start and holds at least the 5 s nap and 5 s wait, which load only stretches; wallMs must leave both out.
    const started = Object.fromEntries(readFileSync(join(out, 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((rec) => [rec.taskId, Date.parse(rec.startedAt)]));
    const stepMs = started.n1 - started.t1;
    const wallMs = t1.wallMs ?? -1;
    expect(Number.isInteger(wallMs) && wallMs >= 0).toBe(true);
    expect(wallMs + 10_000).toBeLessThanOrEqual(stepMs);
  }, 300_000);

  it('a resume that runs out of time marks the record timed out', async () => {
    const { out } = isolate('resume-timeout');
    const r = makeRepo();
    const s = spec(r, [family('f1', [lesson('f1-l1', 'Write the lesson file')])], [
      teach(r, 't1', 'f1-l1', 'LESSON_OK RESUME_HANG_MS=40000'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'look around only'), apply(r, 'a2', 'f1-l1', 'look around only'),
    ]);
    await run(s, ['A0'], out, { sessionTimeoutMs: 15_000 });
    const recs = readRecords(out);
    expect(find(recs, 'A0', 't1')).toMatchObject({ timedOut: true, resolved: false });
    expect(find(recs, 'A0', 'n1').timedOut).toBe(false);
  }, 300_000);

  it('a resume limit that outlasts every wait abandons the run and leaves no z0 ref behind', async () => {
    const { out } = isolate('cut-abandon');
    const r = makeRepo();
    await expect(run(limitSpec(r, ''), ['A0'], out, { limitWaitMs: 0, limitMaxWaits: 0 })).rejects.toThrow(/seqF t1 A0 seed1: still at the plan limit after 0 waits/);
    const refs = execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/z0'], { cwd: workDir(out, 'A0'), encoding: 'utf8' });
    expect(refs.trim()).toBe('');
  }, 120_000);

  it('a plan limit that outlasts every wait still names the limit when the limited attempt also deleted .git', async () => {
    const { out } = isolate('limit-rmgit');
    const r = makeRepo();
    vi.stubEnv('FAKE_CLAUDE_LIMIT_ALWAYS', '1');
    const logs: string[] = [];
    const s = spec(r, [], [task(r, 't1', 'LIMIT RM_GIT look around'), plain(r, 'n1')]);
    await expect(run(s, ['A0'], out, { limitWaitMs: 0, limitMaxWaits: 0, log: (m) => logs.push(m) })).rejects.toThrow(/seqF t1 A0 seed1: still at the plan limit after 0 waits/);
    expect(logs.some((m) => /runner git on the agent's workspace failed/.test(m))).toBe(true);
  }, 120_000);

  it('a session-1 retry rebuilds CHECK_PRE_COMMIT, and the held ref keeps nothing reachable after the task', async () => {
    const { out, log } = isolate('retry');
    const r = makeRepo();
    const newer = stubBaseCommit(r.repo, r.fix);
    vi.stubEnv('FAKE_CLAUDE_LIMIT_ONCE', join(out, 'limit-hit'));
    const s = spec(r, [family('f1', [lesson('f1-l1', 'Write the lesson file', { check: { script: 'lesson.mjs', args: [`has=${newer}`] } })])], [
      teach(r, 't1', 'f1-l1', 'LIMIT LESSON_BAD', { baseRef: r.fix }), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'look around only'), apply(r, 'a2', 'f1-l1', 'look around only'),
    ]);
    const said: string[] = [];
    await run(s, ['A2'], out, { limitWaitMs: 0, log: (m: string) => said.push(m) });
    const t1 = find(readRecords(out), 'A2', 't1');
    expect(t1).toMatchObject({ invalid: null, limitRetries: 1, baseCommit: newer, lessons: [{ first: 'fail', final: 'pass' }] });
    expect(said.some((m) => /t1 A2 seed1: CHECK_PRE_COMMIT rebuilt/.test(m))).toBe(true);
    expect(seen(out, 'A2', 't1')['CLAUDE.md']).toContain('hippo:start');
    const checks = checkLog(log);
    for (const c of checks) expect(c.preRef).toBe(c.pre);
    expect(checks.slice(0, 2).map((c) => c.has)).toEqual([true, true]);
    expect(checks.slice(2).map((c) => c.has)).toEqual(Array(checks.length - 2).fill(false));
    const refs = execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/z0'], { cwd: workDir(out, 'A2'), encoding: 'utf8' });
    expect(refs.trim()).toBe('');
  }, 300_000);
});

