// Z0 set X through runAll: Claude teaches, Codex applies, the carry, the X3 stub and the X4 block (E6 plan tests 6-9, 22).
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { cacheTaskRepos } from '../scripts/token-eval/runs.mjs';
import { STUB_CLAUDE_MD, X3_STUB, stubRefOf, checkoutBase } from '../scripts/token-eval/workspace.mjs';
import { parseZ0Records } from '../scripts/token-eval/z0-records.mjs';
import { cleanup, makeRepo, lesson, family, teach, apply, find, logLines, runRoot, workDir, tmp } from './fixtures/z0-harness.js';
import { xSpec, xRun, xTrio, xIsolate, xRecords, fakeSeen, X_IDS } from './fixtures/z0-codex-harness.js';
import type { XRecord } from './fixtures/z0-codex-harness.js';

afterEach(cleanup);

const ZERO = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

describe('set X end to end (test 6)', () => {
  it('runs teaches in Claude and applies once each in Codex, as records the contract takes', async () => {
    const { out, log, op, codexLog } = xIsolate('e2e');
    const prompts = Object.fromEntries(X_IDS.flatMap((id) => [[`t-${id}`, 'LESSON_BAD'], [`a-${id}`, 'FIX\nLESSON_BAD'], [`b-${id}`, 'FIX\nLESSON_OK']]));
    await xRun(xTrio(makeRepo(), prompts), ['X1'], out, op);
    const { records } = parseZ0Records(readFileSync(join(out, 'runs.jsonl'), 'utf8'), 'runs.jsonl');
    expect(records).toHaveLength(9);
    const recs = xRecords(out);
    for (const id of X_IDS) {
      const t = find(recs, 'X1', `t-${id}`);
      expect([t.tool, t.invalid, t.teachTurns], t.taskId).toEqual(['claude-code', null, 1]);
      for (const [task, first] of [[`a-${id}`, 'fail'], [`b-${id}`, 'pass']]) {
        const a = find(recs, 'X1', task);
        expect([a.tool, a.invalid, a.void, a.correctionTurns, a.acceptancePassed], task).toEqual(['codex', null, null, 0, true]);
        expect(a.lessons[0], task).toMatchObject({ first, final: first });
        expect(a.usage, task).toEqual({ firstSession: { inputTokens: 500, cacheWriteTokens: 0, cacheReadTokens: 1500, outputTokens: 120 }, extra: ZERO });
        expect(a, task).toMatchObject({ costUsd: null, turns: 2, turnsSource: 'rollout', codexAuth: 'copied-file', codexVersion: 'codex-cli 0.153.4-fake', codexMemories: true, codexHookTrust: 'none' });
        expect(a.codexMemoryWait, task).toEqual({ ms: 0, timedOut: false });
      }
    }
    // Only the three teaches resume; a Codex apply gets no correction (prereg 85, 110).
    expect(logLines(log).filter((l) => l.startsWith('resume '))).toHaveLength(3);
    const seen = fakeSeen(codexLog);
    expect(seen).toHaveLength(6);
    for (const x of seen) {
      expect(x.envKeys).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
      expect(x.argv.slice(0, 4)).toEqual(['exec', '--json', '--model', 'gpt-fake']);
      expect(x.home).toBe(join(runRoot(out, 'X1'), 'home'));
    }
  }, 240_000);
});

describe('what carries from a Claude teach to a Codex apply (test 7)', () => {
  it('carries AGENTS.md, and a lesson only in CLAUDE.md is stored but never shown to Codex', async () => {
    const { out, op, codexLog } = xIsolate('carry');
    const prompts = { 't-xa': 'LESSON_BAD\nAPPEND:AGENTS.md:the zq-xa-l1 rule', 't-xb': 'LESSON_BAD\nWRITE_ON_RESUME the zq-xb-l1 rule' };
    await xRun(xTrio(makeRepo(), prompts), ['X1'], out, op);
    const recs = xRecords(out);
    const seen = fakeSeen(codexLog);
    expect(seen).toHaveLength(6);
    expect(seen.every((x) => (x.agents ?? '').includes('the zq-xa-l1 rule'))).toBe(true);
    expect(find(recs, 'X1', 'a-xa').chain).toMatchObject({ stored: true, shown: true });
    expect(find(recs, 'X1', 'a-xb').chain).toMatchObject({ stored: true, shown: false });
  }, 240_000);
});

describe('X3 stub (test 8)', () => {
  it('commits the X3 stub under its own ref beside the plain one, and checkoutBase returns that ref\'s sha', async () => {
    const { out, op } = xIsolate('x3');
    const r = makeRepo();
    await xRun(xTrio(r), ['X3'], out, op);
    expect(git(workDir(out, 'X3'), 'show', 'HEAD:CLAUDE.md')).toBe(X3_STUB);
    const t = { id: 'a-xa', baseRef: r.base };
    expect(stubRefOf('seqF', t, 'X3')).toBe('refs/eval-x3/seqF/a-xa');
    expect(stubRefOf('seqF', t, 'X1')).toBe('refs/eval/seqF/a-xa');
    const cache = join(out, 'repo-cache', 'seqF');
    const shas = [];
    for (const [arm, text] of [['X3', X3_STUB], ['X1', STUB_CLAUDE_MD]]) {
      const sha = checkoutBase(cache, tmp('z0-x3-work-'), 'seqF', t, arm);
      const ref = stubRefOf('seqF', t, arm);
      expect(sha, arm).toBe(git(cache, 'rev-parse', ref).trim());
      expect(git(cache, 'show', `${ref}:CLAUDE.md`), arm).toBe(text);
      shas.push(sha);
    }
    expect(shas[0]).not.toBe(shas[1]);
    // Both refs sit in the one cache now and name different commits.
    const refs = git(cache, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/eval/seqF/a-xa', 'refs/eval-x3/seqF/a-xa').trim().split('\n');
    expect(refs).toEqual([`refs/eval-x3/seqF/a-xa ${shas[0]}`, `refs/eval/seqF/a-xa ${shas[1]}`]);
    // grade.json names the ref the cell was graded from, X3 beside X1.
    const x1 = xIsolate('x3b');
    await xRun(xTrio(r), ['X1'], x1.out, x1.op);
    const stubRef = (o: string, arm: string) => JSON.parse(readFileSync(join(o, 'grading', 'seqF', arm, 'seed1', 'a-xa.grade.json'), 'utf8')).stubRef;
    expect([stubRef(out, 'X3'), stubRef(x1.out, 'X1')]).toEqual(['refs/eval-x3/seqF/a-xa', 'refs/eval/seqF/a-xa']);
  }, 240_000);

  it('refuses a key phrase that only the X3 stub holds', () => {
    const r = makeRepo();
    const fams = X_IDS.map((id) => family(id, [lesson(`${id}-l1`, `Rule ${id} holds`, id === 'xa' ? { keyPhrase: 'When you receive a correction' } : {})]));
    const s = xSpec(r, fams, [
      ...X_IDS.map((id) => teach(r, `t-${id}`, `${id}-l1`, 'look')), ...X_IDS.map((id) => apply(r, `a-${id}`, `${id}-l1`, 'look')), ...X_IDS.map((id) => apply(r, `b-${id}`, `${id}-l1`, 'look')),
    ]);
    expect(() => cacheTaskRepos(s, tmp('z0-x3-cache-'))).toThrow(/stub tree holds lesson xa-l1's key phrase/);
  });
});

describe('X4 block (test 9)', () => {
  it('writes the taught block after a delivered teach, replaces it on reversal, skips an undelivered teach, and keeps one block', async () => {
    const { out, op, codexLog } = xIsolate('x4');
    const r = makeRepo();
    const xa = family('xa', [lesson('xa-l1', 'Rule one holds'), lesson('xa-l2', 'Rule two holds', { supersedes: 'xa-l1' })]);
    const xb = family('xb', [lesson('xb-l1', 'Rule three holds')]);
    const xc = family('xc', [lesson('xc-l1', 'Rule four holds')]);
    const s = xSpec(r, [xa, xb, xc], [
      teach(r, 't1', 'xa-l1', 'LESSON_BAD'), teach(r, 't3', 'xb-l1', 'LESSON_BAD\nNO_RESULT_ON_RESUME'), teach(r, 't4', 'xc-l1', 'LESSON_BAD'),
      apply(r, 'a1', 'xa-l1', 'look'), teach(r, 't2', 'xa-l2', 'LESSON_BAD'), apply(r, 'a3', 'xb-l1', 'look'), apply(r, 'a4', 'xc-l1', 'look'),
      apply(r, 'a2', 'xa-l2', 'look'), apply(r, 'b3', 'xb-l1', 'look'), apply(r, 'b4', 'xc-l1', 'look'),
    ]);
    await xRun(s, ['X4'], out, op);
    const recs = xRecords(out);
    expect(['t1', 't3', 't4', 't2'].map((id) => find(recs, 'X4', id).x4Block)).toEqual(['written', undefined, 'replaced', 'replaced']);
    const agents = fakeSeen(codexLog).map((x) => x.agents ?? '');
    expect(agents).toHaveLength(6);
    expect(agents[0]).toContain('Rule one holds');
    expect(agents[0]).toContain('Rule four holds');
    for (const text of agents.slice(1)) {
      expect(text).toContain('Rule two holds');
      expect(text).not.toContain('Rule one holds');
    }
    for (const text of agents) {
      expect(text).not.toContain('Rule three holds');
      expect(text.split('<!-- z0 taught -->').length - 1).toBe(1);
      expect(text.split('<!-- /z0 taught -->').length - 1).toBe(1);
    }
  }, 240_000);
});

describe('bias (test 22)', () => {
  it('a passing and a failing Codex apply get the same void, invalid, limit, wait and restore fields', async () => {
    const fields = async (name: string, verdict: string) => {
      const { out, op } = xIsolate(name);
      await xRun(xTrio(makeRepo(), { 'a-xa': `FIX\n${verdict}` }), ['X1'], out, op);
      const a = find(xRecords(out), 'X1', 'a-xa');
      expect(a.lessons[0].first).toBe(verdict === 'LESSON_OK' ? 'pass' : 'fail');
      return {
        void: a.void, voidHits: a.voidHits, invalid: a.invalid, limitRetries: a.limitRetries, wait: a.codexMemoryWait, restored: a.surfaceRestored,
        timedOut: a.timedOut, correctionTurns: a.correctionTurns, stray: a.codexStrayRollouts, tool: a.tool,
      };
    };
    const ok = await fields('bias-ok', 'LESSON_OK');
    expect(ok.tool).toBe('codex');
    expect(ok).toEqual(await fields('bias-bad', 'LESSON_BAD'));
  }, 240_000);
});
