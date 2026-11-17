// A4 teaching, invalid record shapes, workspace-git faults, session evidence and the family screen, against the z0-record/1 contract.
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { planRuns } from '../../scripts/token-eval/ab-run.mjs';
import { STUB_CLAUDE_MD } from '../../scripts/token-eval/workspace.mjs';
import { runScreen } from '../../scripts/token-eval/screen.mjs';
import { loadHippo } from '../../scripts/token-eval/runs.mjs';
import { validateCorpus, type Z0Record } from '../fixtures/z0-contract.js';
import { CLAUDE, isolate, makeRepo, type LessonDef, type FamilyDef, lesson, family, task, teach, apply, plain, spec, reversal, run, readRecords, readPlan, logLines, checkLog, seen, find, workDir, expectInvalid, cleanup } from '../fixtures/z0-turns-harness.js';

afterEach(cleanup);

describe('A4 and invalid shapes', () => {
  it('A4 holds each taught lesson in CLAUDE.md from the next task on, a reversal replaces it, A0 never', async () => {
    const { out } = isolate('a4');
    const r = makeRepo();
    const fam = reversal();
    const s = spec(r, [fam], [
      teach(r, 't1', 'f1-l1', 'LESSON_OK'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'LESSON_OK'),
      teach(r, 't2', 'f1-l2', 'LESSON_OK'), plain(r, 'n3'), plain(r, 'n4'), apply(r, 'a3', 'f1-l2', 'LESSON_OK'),
    ]);
    await run(s, ['A0', 'A4'], out);
    const line = (l: LessonDef) => `\n- ${l.rule}, because ${l.reason}.\n`;
    const [l1, l2] = fam.lessons;
    expect(seen(out, 'A4', 't1')['CLAUDE.md']).toBe(STUB_CLAUDE_MD);
    for (const id of ['n1', 'n2', 'a1', 't2']) expect(seen(out, 'A4', id)['CLAUDE.md'], id).toBe(STUB_CLAUDE_MD + line(l1));
    for (const id of ['n3', 'n4', 'a3']) expect(seen(out, 'A4', id)['CLAUDE.md'], id).toBe(STUB_CLAUDE_MD + line(l2));
    for (const id of ['t1', 'n1', 'a1', 'a3']) expect(seen(out, 'A0', id)['CLAUDE.md'], id).toBe(STUB_CLAUDE_MD);
    const steps: Array<{ arm: string; seed: number; taskId: string; position: number }> = planRuns(s, ['A0', 'A1', 'A2', 'A4', 'A5']);
    const a4Seeds = new Set(steps.filter((x) => x.arm === 'A4').map((x) => x.seed));
    expect([...a4Seeds].sort()).toEqual([1, 2]);
  }, 300_000);

  it('A4 is told a lesson only when its teach resume gave a result; invalid teach records leave their applies unchecked', async () => {
    const { out, log } = isolate('a4inv');
    const r = makeRepo();
    const fams = ['fA', 'fB', 'fC'].map((f) => family(f, [lesson(`${f}-l1`, `Write the ${f} file`, f === 'fB' ? { check: { script: 'lesson.mjs', args: ['exit=2'] } } : {})]));
    const s = spec(r, fams, [
      teach(r, 'tA', 'fA-l1', 'LESSON_OK NO_RESULT_ON_RESUME'), teach(r, 'tB', 'fB-l1', 'LESSON_OK'), teach(r, 'tC', 'fC-l1', 'LESSON_OK NOTRANSCRIPT'),
      apply(r, 'aA1', 'fA-l1', 'look around only'), apply(r, 'aB1', 'fB-l1', 'look around only'), apply(r, 'aC1', 'fC-l1', 'look around only'),
      apply(r, 'aA2', 'fA-l1', 'look around only'), apply(r, 'aB2', 'fB-l1', 'look around only'), apply(r, 'aC2', 'fC-l1', 'look around only'),
    ]);
    await run(s, ['A4'], out);
    const recs = readRecords(out);
    const md = seen(out, 'A4', 'aA1')['CLAUDE.md'];
    expect(md).not.toContain('Write the fA file');
    expect(md).toContain('- Write the fB file, because');
    expect(md).toContain('- Write the fC file, because');
    expectInvalid(find(recs, 'A4', 'tA'), 'resume');
    expectInvalid(find(recs, 'A4', 'tB'), 'checker');
    expectInvalid(find(recs, 'A4', 'tC'), 'no-transcript');
    expect(logLines(log)).toContain(`resume ${find(recs, 'A4', 'tB').sessionId}`);
    const aB1 = find(recs, 'A4', 'aB1');
    expectInvalid(aB1, 'checker');
    expect(logLines(log).filter((l) => l === `resume ${aB1.sessionId}`)).toEqual([]);
    expect(existsSync(join(out, 'raw', 'seqF', 'A4', 'seed1', 'aB1.checker.txt'))).toBe(true);
    expect(validateCorpus(recs, readPlan(out)).sort()).toEqual(['aA1', 'aA2', 'aB1', 'aB2', 'aC1', 'aC2']);
  }, 300_000);

  it('no-result and setup shapes carry the full field set; a crashed teach leaves its applies unchecked', async () => {
    const { out } = isolate('shapes');
    const r = makeRepo();
    const s = spec(r, [family('f1', [lesson('f1-l1', 'Write the lesson file')])], [
      teach(r, 't1', 'f1-l1', 'CRASH'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'LESSON_OK', { setup: 'exit 1' }), apply(r, 'a2', 'f1-l1', 'LESSON_OK'),
    ]);
    await run(s, ['A1'], out);
    const recs = readRecords(out);
    expectInvalid(find(recs, 'A1', 't1'), 'no-result');
    const a1 = find(recs, 'A1', 'a1');
    expectInvalid(a1, 'setup');
    expect(a1).toMatchObject({ carryUnionMerges: null, kind: 'apply', familyId: 'f1', lessonId: 'f1-l1', applyIndex: 1 });
    expect(validateCorpus(recs, readPlan(out)).sort()).toEqual(['a1', 'a2']);
  }, 300_000);
});


describe('an agent that breaks its workspace git', () => {
  it('an orphan HEAD or a deleted .git makes that cell invalid: workspace, and the run goes on', async () => {
    const { out, log } = isolate('broken-git');
    const r = makeRepo();
    const s = spec(r, [family('f1', [lesson('f1-l1', 'Write the lesson file')])], [
      teach(r, 't1', 'f1-l1', 'LESSON_OK ORPHAN'), task(r, 'n1', 'RM_GIT'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'LESSON_BAD RM_GIT'), apply(r, 'a2', 'f1-l1', 'LESSON_OK'),
    ]);
    await run(s, ['A0'], out);
    const recs = readRecords(out);
    expect(recs.map((x) => x.taskId)).toEqual(['t1', 'n1', 'n2', 'a1', 'a2']);
    for (const id of ['t1', 'n1', 'a1']) expectInvalid(find(recs, 'A0', id), 'workspace');
    expect(find(recs, 'A0', 'n2').invalid).toBeNull();
    expect(find(recs, 'A0', 'a2')).toMatchObject({ invalid: null, lessons: [{ first: 'pass', final: 'pass' }] });
    expect(logLines(log).filter((l) => l.startsWith('resume '))).toEqual([]);
    expect(readFileSync(join(out, 'raw', 'seqF', 'A0', 'seed1', 't1.workspace.txt'), 'utf8')).toMatch(/HEAD/);
    expect(validateCorpus(recs, readPlan(out)).sort()).toEqual(['a1', 'a2']);
  }, 300_000);
});


describe('session evidence', () => {
  it('CHECK_COMMANDS and the work counts take in subagent transcripts', async () => {
    const { out, log } = isolate('subagent');
    const r = makeRepo();
    const s = spec(r, [family('f1', [lesson('f1-l1', 'Write the lesson file')])], [
      teach(r, 't1', 'f1-l1', 'LESSON_BAD\nSUBAGENT_CMD npm run lint'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'look around only'), apply(r, 'a2', 'f1-l1', 'look around only'),
    ]);
    await run(s, ['A0'], out);
    const recs = readRecords(out);
    const checks = checkLog(log).filter((c) => c.lesson === 'f1-l1');
    expect(checks[0].commands).toEqual(['git status && cat lib.js', 'npm run lint']);
    expect(checks[1].commands).toEqual(['git status && cat lib.js', 'echo resumed No:', 'npm run lint']);
    // CHECK_RESUME_COMMANDS: what each transcript gained since the first check, so the subagent's earlier command stays out. The applies' first checks get none.
    expect(checks.map((c) => c.resume)).toEqual([null, ['echo resumed No:'], null, null]);
    expect(JSON.parse(readFileSync(join(out, 'grading', 'seqF', 'A0', 'seed1', 't1.grade.json'), 'utf8')).commandsResume).toEqual(['echo resumed No:']);
    // Session 1 makes 3 tool calls, its subagent 1 and the resume 1.
    expect(find(recs, 'A0', 'n1').toolCalls).toBe(3);
    expect(find(recs, 'A0', 't1').toolCalls).toBe(5);
  }, 300_000);

  it('raw session and resume JSON stay whole past 20,000 characters; a result with no session id is no-transcript', async () => {
    const { out, log } = isolate('raw');
    const r = makeRepo();
    const s = spec(r, [family('f1', [lesson('f1-l1', 'Write the lesson file')]), family('f2', [lesson('f2-l1', 'Write the f2 file')])], [
      teach(r, 't1', 'f1-l1', 'LESSON_BAD BIG_RESULT'), teach(r, 't2', 'f2-l1', 'LESSON_OK NO_SESSION_ID'), task(r, 'n1', 'NO_SESSION_ID'), plain(r, 'n2'),
      apply(r, 'a1', 'f1-l1', 'look around only'), apply(r, 'b1', 'f2-l1', 'look around only'), apply(r, 'a2', 'f1-l1', 'look around only'), apply(r, 'b2', 'f2-l1', 'look around only'),
    ]);
    await run(s, ['A0'], out);
    const raw = (name: string) => JSON.parse(readFileSync(join(out, 'raw', 'seqF', 'A0', 'seed1', name), 'utf8'));
    expect(raw('t1.json').pad).toHaveLength(30_000);
    expect(raw('t1.resume.json').pad).toHaveLength(30_000);
    const recs = readRecords(out);
    expectInvalid(find(recs, 'A0', 't2'), 'no-transcript');
    expectInvalid(find(recs, 'A0', 'n1'), 'no-transcript');
    expect(logLines(log).filter((l) => l.startsWith('resume ') && !l.startsWith('resume-'))).toEqual([`resume ${find(recs, 'A0', 't1').sessionId}`]);
  }, 300_000);

  it('the hippo field sums the ledger over both turns when the resume has its own session id', async () => {
    const { out } = isolate('hippo-sum');
    const r = makeRepo();
    // n0 stores a memory first, and both t1 prompts share its words, so prompt recall injects on both turns.
    const s = spec(r, [family('f1', [lesson('f1-l1', 'Write the lesson file for add in lib.js')])], [
      task(r, 'n0', 'FIX add in lib.js'), teach(r, 't1', 'f1-l1', 'LESSON_OK NEW_ID_ON_RESUME add in lib.js'),
      plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'look around only'), apply(r, 'a2', 'f1-l1', 'look around only'),
    ]);
    await run(s, ['A2'], out);
    const t1 = find(readRecords(out), 'A2', 't1');
    expect(t1.resumeSessionId).not.toBe(t1.sessionId);
    const lib = await loadHippo();
    const db = lib.openHippoDb(join(workDir(out, 'A2'), '.hippo'));
    const rows = lib.tokensBySession(db, 'default', '1970-01-01T00:00:00.000Z').filter((x: { sessionId: string }) => [t1.sessionId, t1.resumeSessionId].includes(x.sessionId));
    lib.closeHippoDb(db);
    expect(rows).toHaveLength(2);
    // n0's memory is the store's one row and matches each prompt, so each turn books its recall block and no static one.
    for (const x of rows) expect(x.injections, x.sessionId).toBe(1);
    const total = (k: 'sent' | 'skipped' | 'injections') => rows.reduce((n: number, x: Record<string, number>) => n + x[k], 0);
    expect(t1.hippo).toEqual({ sessionId: t1.sessionId, sent: total('sent'), skipped: total('skipped'), injections: total('injections') });
  }, 300_000);
});


describe('family screen', () => {
  it('keeps, drops and leaves undecided from the first checks; A0 and A4 only, no resume', async () => {
    const { out, log } = isolate('screen');
    const r = makeRepo();
    const screened = (id: string, prompt: string, args: string[] = []): FamilyDef => ({
      ...family(id, [lesson(`${id}-l1`, `Write the ${id} file`, { check: { script: 'lesson.mjs', args } })]),
      screen: { id: `${id}-screen`, baseRef: r.base, fixRef: r.fix, prompt, test: 'node test.js', testFiles: ['test.js'] },
    });
    const ids = ['fK', 'fD', 'fU'];
    const s = spec(r, [screened('fK', 'LESSON_TOLD SEED2_OK'), screened('fD', 'LESSON_TOLD SEED2_BAD'), screened('fU', 'LESSON_TOLD', ['exit=5'])], [
      ...ids.map((f) => teach(r, `t${f}`, `${f}-l1`, 'LESSON_BAD')), plain(r, 'n1'), plain(r, 'n2'),
      ...ids.map((f) => apply(r, `a${f}1`, `${f}-l1`, 'look around only')), ...ids.map((f) => apply(r, `a${f}2`, `${f}-l1`, 'look around only')),
    ]);
    const v = await runScreen({ spec: s, outDir: out, claudeBin: CLAUDE, settleMs: 0, warmup: false, log: () => {} });
    expect(v.kept).toEqual(['fK']);
    expect(v.families.find((f: { familyId: string }) => f.familyId === 'fK')).toMatchObject({ a0Breaks: 3, a0Of: 4, a4Follows: 2, a4Of: 2 });
    expect(v.dropped).toEqual([{ familyId: 'fD', a0Breaks: 4, a0Of: 4, a4Follows: 1, a4Of: 2, verdict: 'dropped' }]);
    expect(v.undecided).toEqual([expect.objectContaining({ familyId: 'fU', verdict: 'undecided', reason: expect.stringMatching(/invalid checker$/) })]);
    expect(JSON.parse(readFileSync(join(out, 'screen.json'), 'utf8'))).toEqual(v);
    const recs: Z0Record[] = readFileSync(join(out, 'screen.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(recs).toHaveLength(18);
    expect([...new Set(recs.map((x) => x.arm))].sort()).toEqual(['A0', 'A4']);
    for (const x of recs) expect(x).toMatchObject({ kind: 'screen', screen: true, resumeSessionId: null });
    expect(recs.filter((x) => x.arm === 'A0').map((x) => x.taskId)).toEqual(expect.arrayContaining(['tfK', 'fK-screen']));
    expect(logLines(log).filter((l) => l.startsWith('resume-msg'))).toEqual([]);
    expect(existsSync(join(out, 'runs.jsonl'))).toBe(false);
  }, 300_000);

  it('runs A0 and A4 and opens no Codex login when the tasks file holds a set X sequence and the caller names X arms', async () => {
    const { out } = isolate('screen-x');
    const r = makeRepo();
    const fam: FamilyDef = { ...family('fK', [lesson('fK-l1', 'Write the fK file')]), screen: { id: 'fK-screen', baseRef: r.base, fixRef: r.fix, prompt: 'LESSON_TOLD SEED2_OK', test: 'node test.js', testFiles: ['test.js'] } };
    const s = spec(r, [fam], [teach(r, 'tK', 'fK-l1', 'LESSON_BAD'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'aK1', 'fK-l1', 'look around only'), apply(r, 'aK2', 'fK-l1', 'look around only')]);
    const withX = { ...s, sequences: [...s.sequences, { id: 'seqX', cluster: 'c', repo: r.repo, fixedOrder: true, set: 'X', tasks: [plain(r, 'x1'), plain(r, 'x2')] }] };
    // isolate gives the run an empty HOME, so opening the Codex vault would throw for want of a login before the first session.
    const v = await runScreen({ spec: withX, arms: ['X1', 'X2'], outDir: out, claudeBin: CLAUDE, settleMs: 0, warmup: false, log: () => {} });
    expect(v.families.map((f: { familyId: string }) => f.familyId)).toEqual(['fK']);
    const recs: Z0Record[] = readFileSync(join(out, 'screen.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect([...new Set(recs.map((x) => x.arm))].sort()).toEqual(['A0', 'A4']);
  }, 300_000);

  it('a screen task with a symlinked instruction file stops the screen before any session', async () => {
    const { out, log } = isolate('screen-link');
    const r = makeRepo();
    const g = (...args: string[]): string => execFileSync('git', args, { cwd: r.repo, encoding: 'utf8' }).trim();
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: r.repo, input: 'policy.md', encoding: 'utf8' }).trim();
    g('update-index', '--add', '--cacheinfo', `120000,${blob},docs/AGENTS.md`);
    g('commit', '-qm', 'link');
    const fam = { ...family('fL', [lesson('fL-l1', 'Write the fL file')]), screen: { id: 'fL-screen', baseRef: g('rev-parse', 'HEAD'), fixRef: r.fix, prompt: 'x', test: 'node test.js', testFiles: ['test.js'] } };
    const s = spec(r, [fam], [teach(r, 'tL', 'fL-l1', 'LESSON_BAD'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'aL1', 'fL-l1', 'x'), apply(r, 'aL2', 'fL-l1', 'x')]);
    await expect(runScreen({ spec: s, outDir: out, claudeBin: CLAUDE, settleMs: 0, warmup: false, log: () => {} }))
      .rejects.toThrow('Z0 task seqF/fL-screen: instruction file docs/AGENTS.md is a symlink in the task repo');
    expect(logLines(log)).toEqual([]);
  }, 60_000);
});

