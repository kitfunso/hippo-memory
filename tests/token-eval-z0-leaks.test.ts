// Z0 G3 (prereg 164) with the fake Claude Code: a key phrase readable before its teach voids the (sequence, seed), and preflight refuses static leaks.
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { preflight } from '../scripts/token-eval/ab-run.mjs';
import { abandonedTail, validateCorpus } from './fixtures/z0-contract.js';
import {
  cleanup, tmp, isolate, makeRepo, task, teach, apply, plain, lesson, family, spec, run, readRecords, readPlan, find, logLines,
} from './fixtures/z0-harness.js';

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const sessions = (log: string) => logLines(log).filter((l) => l.startsWith('session '));
const f1 = (keyPhrase?: string) => [family('f1', [lesson('f1-l1', 'Write the lesson file', keyPhrase ? { keyPhrase } : {})])];
/** n0, then teach t1, two plain tasks and the applies a1 and a2; n0's prompt and setup and n1's prompt vary per test. */
function leakSpec(r: ReturnType<typeof makeRepo>, n0: string, opts: { n0Setup?: string; n1?: string; t1Setup?: string; keyPhrase?: string } = {}) {
  return spec(r, f1(opts.keyPhrase), [
    task(r, 'n0', n0, opts.n0Setup ? { setup: opts.n0Setup } : {}), teach(r, 't1', 'f1-l1', 'look around only', opts.t1Setup ? { setup: opts.t1Setup } : {}),
    task(r, 'n1', opts.n1 ?? 'look around only'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'look around only'), apply(r, 'a2', 'f1-l1', 'look around only'),
  ]);
}

describe('G3 leak search before the teach', () => {
  afterEach(cleanup);

  it('a key phrase in auto memory before its teach voids the (sequence, seed), and every planned cell still gets a record', async () => {
    const { out, log } = isolate('leak-mem');
    const r = makeRepo();
    await run(leakSpec(r, `MEMWRITE_B64:${b64('note zq-f1-l1')}`), ['A1', 'A0'], out);
    const recs = readRecords(out);
    const plan = readPlan(out);
    const t1 = find(recs, 'A1', 't1');
    expect(t1).toMatchObject({ invalid: 'leak', leak: true });
    expect(t1.leakHits?.[0]).toMatchObject({ lessonId: 'f1-l1', surface: 'autoMemory', path: expect.stringMatching(/memory\/MEMORY\.md$/) });
    expect(sessions(log)).toHaveLength(2);
    const later = recs.filter((x) => x.position >= 1 && !(x.arm === 'A1' && x.taskId === 't1'));
    expect(later).toHaveLength(9);
    for (const x of later) expect(x, `${x.arm} ${x.taskId}`).toMatchObject({ invalid: 'leak', leak: true, leakFrom: { arm: 'A1', position: 1, taskId: 't1' } });
    expect(abandonedTail(recs, plan)).toEqual([]);
    expect(recs).toHaveLength(plan.length);
    expect(() => validateCorpus(recs, plan)).not.toThrow();
  }, 300_000);

  it('the phrase after its teach is no leak', async () => {
    const { out } = isolate('leak-after');
    const r = makeRepo();
    await run(leakSpec(r, 'look around only', { n1: 'MEMWRITE:zq-f1-l1' }), ['A1'], out);
    const recs = readRecords(out);
    expect(recs).toHaveLength(6);
    for (const x of recs) expect(x, x.taskId).toMatchObject({ invalid: null, leak: false });
  }, 300_000);

  it('the phrase in the workspace before its teach is a leak', async () => {
    const { out, log } = isolate('leak-work');
    const r = makeRepo();
    const n0Setup = 'node -e "require(\'fs\').writeFileSync(\'notes.txt\', \'see ZQ-F1-L1\')"';
    await run(leakSpec(r, 'look around only', { n0Setup }), ['A1'], out);
    const n0 = find(readRecords(out), 'A1', 'n0');
    expect(n0).toMatchObject({ invalid: 'leak', leak: true });
    expect(n0.leakHits).toContainEqual({ lessonId: 'f1-l1', surface: 'workspace', path: 'work/notes.txt' });
    expect(sessions(log)).toEqual([]);
  }, 300_000);

  it('in A2 a gzip in .hippo holding the phrase is a hippoWork leak and a zip one it cannot open is hippoWork-archive', async () => {
    const { out } = isolate('leak-archive');
    const r = makeRepo();
    const setup = 'node -e "const f=require(\'fs\'),z=require(\'zlib\');f.writeFileSync(\'.hippo/x.gz\',z.gzipSync(\'note zq-f1-l1\'));f.writeFileSync(\'.hippo/y.zip\',Buffer.from([80,75,3,4,0,0]))"';
    const s = spec(r, f1(), [
      plain(r, 'n0'), task(r, 'n1', 'look around only', { setup }), teach(r, 't1', 'f1-l1', 'look around only'),
      plain(r, 'n2'), plain(r, 'n3'), apply(r, 'a1', 'f1-l1', 'look around only'), apply(r, 'a2', 'f1-l1', 'look around only'),
    ]);
    await run(s, ['A2'], out);
    const recs = readRecords(out);
    expect(find(recs, 'A2', 'n0')).toMatchObject({ invalid: null, leak: false });
    const n1 = find(recs, 'A2', 'n1');
    expect(n1).toMatchObject({ invalid: 'leak', leak: true });
    expect(n1.leakHits).toContainEqual({ lessonId: 'f1-l1', surface: 'hippoWork', path: 'work/.hippo/x.gz' });
    expect(n1.leakHits).toContainEqual({ lessonId: null, surface: 'hippoWork-archive', path: 'work/.hippo/y.zip' });
    expect(recs).toHaveLength(7);
  }, 300_000);

  it('a teach whose setup failed still closes its lesson', async () => {
    const { out } = isolate('leak-setup');
    const r = makeRepo();
    await run(leakSpec(r, 'look around only', { t1Setup: 'exit 1', n1: 'MEMWRITE:zq-f1-l1' }), ['A1'], out);
    const recs = readRecords(out);
    expect(find(recs, 'A1', 't1').invalid).toBe('setup');
    expect(recs.filter((x) => x.leak)).toEqual([]);
    expect(find(recs, 'A1', 'a1').invalid).toBeNull();
  }, 300_000);

  it('a non-ASCII phrase is found, its ASCII letters in any case', async () => {
    const { out } = isolate('leak-utf8');
    const r = makeRepo();
    await run(leakSpec(r, `MEMWRITE_B64:${b64('xx GRößE yy')}`, { keyPhrase: 'Größe' }), ['A1'], out);
    const t1 = find(readRecords(out), 'A1', 't1');
    expect(t1).toMatchObject({ invalid: 'leak', leak: true });
    expect(t1.leakHits?.[0]).toMatchObject({ lessonId: 'f1-l1', surface: 'autoMemory' });
  }, 300_000);
});

describe('preflight phrase checks', () => {
  afterEach(cleanup);

  /** preflight in real mode; out sits in a fresh temp dir, which is also where the ancestor walk stops. */
  function preflightOf(s: ReturnType<typeof spec>) {
    const stopAt = tmp('z0-preflight-');
    const out = join(stopAt, 'out');
    return { out, call: () => preflight(s, out, 'real', stopAt) };
  }

  const refusals: Array<[string, (r: ReturnType<typeof makeRepo>) => ReturnType<typeof spec>, RegExp]> = [
    ['a stub tree holding a phrase', (r) => leakSpec(r, 'look around only'), /seqF\/n0: the stub tree holds lesson f1-l1's key phrase "zq-f1-l1" in notes\.txt/],
    ['a rule holding another lesson\'s phrase', (r) => spec(r, [family('f1', [lesson('f1-l1', 'Write zq-f2-l1 first')]), family('f2', [lesson('f2-l1', 'Write the other file')])], [
      teach(r, 't1', 'f1-l1', 'look around only'), teach(r, 't2', 'f2-l1', 'look around only'), plain(r, 'n1'), plain(r, 'n2'),
      apply(r, 'a1', 'f1-l1', 'look around only'), apply(r, 'a2', 'f1-l1', 'look around only'), apply(r, 'b1', 'f2-l1', 'look around only'), apply(r, 'b2', 'f2-l1', 'look around only'),
    ]), /lesson f1-l1: its rule holds lesson f2-l1's key phrase/],
    ['a no-lesson prompt with keyPhraseAllowed holding a phrase', (r) => spec(r, f1(), [
      teach(r, 't1', 'f1-l1', 'look around only'), task(r, 'n1', 'tidy zq-f1-l1', { keyPhraseAllowed: true }), plain(r, 'n2'),
      apply(r, 'a1', 'f1-l1', 'look around only'), apply(r, 'a2', 'f1-l1', 'look around only'),
    ]), /task seqF\/n1: keyPhraseAllowed .* lesson f1-l1's key phrase/],
  ];
  for (const [name, build, re] of refusals) {
    it(`refuses ${name} before any run, with no ABANDONED file`, () => {
      isolate('preflight');
      const r = name.startsWith('a stub') ? makeRepo({ 'notes.txt': 'see ZQ-F1-L1 here\n' }) : makeRepo();
      const { out, call } = preflightOf(build(r));
      expect(call).toThrow(re);
      expect(existsSync(join(out, 'ABANDONED'))).toBe(false);
    });
  }

  it('passes a reversal whose rule holds its root\'s phrase', () => {
    isolate('preflight-reversal');
    const r = makeRepo();
    const s = spec(r, [family('f1', [lesson('f1-l1', 'Write the lesson file'), lesson('f1-l2', 'Write zq-f1-l1 no more', { supersedes: 'f1-l1' })])], [
      teach(r, 't1', 'f1-l1', 'look around only'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'look around only'), apply(r, 'a2', 'f1-l1', 'look around only'),
      teach(r, 't2', 'f1-l2', 'look around only'), plain(r, 'n3'), plain(r, 'n4'), apply(r, 'a3', 'f1-l2', 'look around only'),
    ]);
    expect(preflightOf(s).call).not.toThrow();
  });
});
