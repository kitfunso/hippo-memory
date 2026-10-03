// Z0 memory surfaces with the fake Claude Code: the run ledger, the retry restores and the record contract E7 reads.
// Costs nothing; no real claude or codex session runs.
import { describe, it, expect, afterEach } from 'vitest';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runDirs, freshRunDirs } from '../scripts/token-eval/homes.mjs';
import { snapshotSurfaces, restoreSurfaces } from '../scripts/token-eval/surfaces.mjs';
import { validateRecord, validateCorpus, abandonedTail, type Z0Record } from './fixtures/z0-contract';
import {
  cleanup, tmp, isolate, makeRepo, task, plain, teach, apply, family, lesson, spec, run,
  readRecords, readPlan, readLedger, rawResult, find, runRoot, type LedgerLine,
} from './fixtures/z0-harness';

afterEach(cleanup);

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const lineOf = (lines: LedgerLine[], arm: string, id: string, when: string) => lines.find((l) => l.arm === arm && l.taskId === id && l.when === when)!;
const SURFACE_KEYS = ['autoMemory', 'codexMemories', 'hippoGlobal', 'hippoWork', 'instructions', 'userInstructions'];

/** A run object and ctx for calling the surface functions directly. */
function unitRun(name: string) {
  const out = tmp(`z0-surf-unit-${name}-`);
  const dirs = runDirs(out, 'seqU', 'A2', 1);
  freshRunDirs(dirs);
  const ctx = { outDir: out, snapDir: join(out, 'snap'), ledgerFile: join(out, 'ledger.jsonl'), log: () => {} };
  const r = { s: { id: 'seqU' }, arm: 'A2', seed: 1, dirs, runName: 'seqU' };
  const step = { t: { id: 'u1' }, position: 0, order: 0 };
  const memory = join(dirs.claudeConfig, 'projects', 'p', 'memory', 'MEMORY.md');
  mkdirSync(join(memory, '..'), { recursive: true });
  writeFileSync(memory, 'kept line\n');
  mkdirSync(join(dirs.work, '.hippo'), { recursive: true });
  writeFileSync(join(dirs.work, '.hippo', 'store.txt'), 'store\n');
  return { out, ctx, r, step, dirs, memory };
}

describe('the surface ledger (prereg 104)', () => {
  it('hashes every surface before and after each session; the hashes match the files', async () => {
    const { out } = isolate('ledger');
    const r = makeRepo();
    await run(spec(r, [], [task(r, 'n1', 'MEMWRITE:a remembered line'), plain(r, 'n2')]), ['A1', 'A2'], out);
    const lines = readLedger(out);
    for (const arm of ['A1', 'A2']) {
      // A hippo arm also logs the rows its hook injected (prereg 93).
      const whens = arm === 'A2' ? ['pre-session', 'end', 'injected'] : ['pre-session', 'end'];
      for (const id of ['n1', 'n2']) expect(lines.filter((l) => l.arm === arm && l.taskId === id).map((l) => l.when), `${arm} ${id}`).toEqual(whens);
      const pre = lineOf(lines, arm, 'n2', 'pre-session');
      expect(pre).toMatchObject({ schema: 'z0-ledger/1', runName: 'seqF', sequence: 'seqF', seed: 1, position: 1, restorable: true, verified: null, copyErrors: [] });
      expect(Object.keys(pre.surfaces).sort()).toEqual(SURFACE_KEYS);
      expect(pre.surfaces.autoMemory.map((e) => e.path)).toEqual([expect.stringMatching(/^claude-config\/projects\/[^/]+\/memory\/MEMORY\.md$/)]);
      expect(pre.surfaces.instructions.map((e) => e.path)).toContain('work/CLAUDE.md');
      expect(pre.surfaces.hippoWork.length > 0, arm).toBe(arm === 'A2');
      const end = lineOf(lines, arm, 'n2', 'end');
      for (const entries of Object.values(end.surfaces)) {
        for (const e of entries) {
          const bytes = readFileSync(join(runRoot(out, arm), e.path));
          expect({ sha256: e.sha256, size: e.size }, e.path).toEqual({ sha256: sha(bytes), size: bytes.length });
        }
      }
    }
    for (const x of readRecords(out)) expect(x.surfaceRestored, `${x.arm} ${x.taskId}`).toBe(true);
  }, 300_000);

  it('records a symlink in a surface as a link and never follows it', () => {
    const { ctx, r, step, dirs } = unitRun('link');
    const target = join(dirs.root, 'outside.txt');
    writeFileSync(target, 'outside the surface\n');
    try {
      symlinkSync(target, join(dirs.work, '.hippo', 'link.txt'));
    } catch (err) {
      // Windows without developer mode refuses symlinks; the walk has nothing to show then.
      if (err instanceof Error && 'code' in err && err.code === 'EPERM') return;
      throw err;
    }
    const snap = snapshotSurfaces(ctx, r, 'pre-session', step);
    const entry = snap.surfaces.hippoWork.find((e: { path: string }) => e.path.endsWith('link.txt'));
    expect(entry).toMatchObject({ path: 'work/.hippo/link.txt', link: true });
    expect(entry.sha256).toBe(sha(target));
    expect(lstatSync(join(snap.copyDir, 'hippoWork', '.hippo', 'link.txt')).isSymbolicLink()).toBe(true);
  });
});

describe('retry restores (prereg 114)', () => {
  for (const arm of ['A1', 'A2']) {
    it(`a session-1 retry puts back every surface the cut-off attempt wrote (${arm})`, async () => {
      const { out } = isolate(`retry-${arm}`);
      const r = makeRepo();
      process.env.FAKE_CLAUDE_LIMIT_ONCE = join(out, 'limit-hit');
      await run(spec(r, [], [task(r, 'n1', 'LIMIT LIMIT_SURFACES look around'), plain(r, 'n2')]), [arm], out, { limitWaitMs: 0 });
      const seen = rawResult(out, arm, 'n1.json');
      expect(seen.memory ?? '').not.toContain('cutoff');
      expect(seen).toMatchObject({ hippoLimit: false, homeLimit: false });
      expect(find(readRecords(out), arm, 'n1')).toMatchObject({ invalid: null, limitRetries: 1, surfaceRestored: true });
      const lines = readLedger(out);
      const restore = lineOf(lines, arm, 'n1', 'retry-restore');
      expect(restore.verified).toBe(true);
      const pre = lineOf(lines, arm, 'n1', 'pre-session');
      expect(Object.keys(restore.surfaces).sort()).toEqual(SURFACE_KEYS.filter((k) => k !== 'instructions'));
      for (const [k, entries] of Object.entries(restore.surfaces)) expect(entries, k).toEqual(pre.surfaces[k]);
    }, 300_000);
  }

  it('a resume retry puts back every surface the cut-off resume wrote', async () => {
    const { out } = isolate('resume-restore');
    const r = makeRepo();
    const s = spec(r, [family('f1', [lesson('f1-l1', 'Write the lesson file')])], [
      teach(r, 't1', 'f1-l1', 'LESSON_BAD CUT_ON_RESUME LIMIT_SURFACES\nMEMWRITE_ON_RESUME:resume note'), plain(r, 'n1'), plain(r, 'n2'),
      apply(r, 'a1', 'f1-l1', 'look around only'), apply(r, 'a2', 'f1-l1', 'look around only'),
    ]);
    await run(s, ['A1', 'A2'], out, { limitWaitMs: 0 });
    const lines = readLedger(out);
    for (const arm of ['A1', 'A2']) {
      const seen = rawResult(out, arm, 't1.resume.json');
      expect(seen.memory ?? '', arm).not.toMatch(/cutoff|resume note/);
      expect(seen, arm).toMatchObject({ hippoLimit: false, homeLimit: false });
      expect(find(readRecords(out), arm, 't1'), arm).toMatchObject({ invalid: null, limitRetries: 1, surfaceRestored: true, lessons: [{ first: 'fail', final: 'pass' }] });
      const restore = lineOf(lines, arm, 't1', 'resume-restore');
      expect(restore.verified, arm).toBe(true);
      const pre = lineOf(lines, arm, 't1', 'pre-resume');
      for (const [k, entries] of Object.entries(restore.surfaces)) expect(entries, `${arm} ${k}`).toEqual(pre.surfaces[k]);
      // The rerun's own write is the one that stays.
      expect(pre.surfaces.autoMemory, arm).toEqual([]);
      const memory = join(runRoot(out, arm), lineOf(lines, arm, 't1', 'end').surfaces.autoMemory[0].path);
      expect(readFileSync(memory, 'utf8'), arm).toBe('resume note\n');
    }
  }, 300_000);

  it('a restore from a copy that lost a file reports false', () => {
    const { out, ctx, r, step, memory } = unitRun('corrupt');
    const snap = snapshotSurfaces(ctx, r, 'pre-session', step);
    appendFileSync(memory, 'written by the cut-off attempt\n');
    expect(restoreSurfaces(ctx, r, snap, 'retry-restore', step)).toBe(true);
    expect(readFileSync(memory, 'utf8')).toBe('kept line\n');
    appendFileSync(memory, 'written again\n');
    rmSync(join(snap.copyDir, 'autoMemory', 'p', 'MEMORY.md'));
    expect(restoreSurfaces(ctx, r, snap, 'retry-restore', step)).toBe(false);
    const lines = readLedger(out);
    expect(lines.map((l) => [l.when, l.verified])).toEqual([['pre-session', null], ['retry-restore', true], ['retry-restore', false]]);
    expect(existsSync(memory)).toBe(false);
  });
});

describe('the z0-record/1 contract copy (E7)', () => {
  const ok: Z0Record = {
    schema: 'z0-record/1', set: 'R', tool: 'claude-code', repo: 'r', sequence: 's', taskId: 'a1', seed: 1, arm: 'A2', position: 3, order: 3,
    kind: 'apply', familyId: 'f1', lessonSource: 'maintainer', lessonId: 'f1-l1', applyIndex: 1, afterReversal: false, tasksSinceTeach: 2, wordOverlap: 0,
    lessons: [{ lessonId: 'f1-l1', first: 'pass', final: 'pass', staleFollow: null }], usage: null, costUsd: null, turns: null, toolCalls: null,
    fileReads: null, shellReads: null, repeatedErrors: null, wallMs: null, teachTurns: null, correctionTurns: null, teachForm: null,
    acceptancePassed: null, timedOut: false, leak: false, resolved: false, invalid: 'checker', void: 'read', limitRetries: 0, carryUnionMerges: 0,
    sessionId: null, resumeSessionId: null, transcriptFound: false, hippo: null, agentError: null, surfaceRestored: false,
    chain: { stored: true, shown: true, followed: true, captured: false },
  };

  it('takes a named void, surfaceRestored and chain, and refuses their wrong shapes', () => {
    expect(() => validateRecord(ok)).not.toThrow();
    expect(() => validateRecord({ ...ok, void: '' })).toThrow(/void/);
    // A JSON round trip types the wrong shapes as any, the way a corpus line arrives.
    expect(() => validateRecord(JSON.parse(JSON.stringify({ ...ok, surfaceRestored: 'yes' })))).toThrow(/surfaceRestored/);
    expect(() => validateRecord(JSON.parse(JSON.stringify({ ...ok, chain: { ...ok.chain, shown: 'x' } })))).toThrow(/chain.shown/);
    expect(() => validateRecord({ ...ok, arm: 'A1', chain: { ...ok.chain!, captured: true } })).toThrow(/captured/);
  });

  it('abandonedTail lists the planned cells past each arm run\'s last record', () => {
    const cell = (position: number, arm: string) => ({ seed: 1, position, arm, sequence: 's', taskId: `t${position}`, repo: 'r', kind: 'no-lesson', familyId: null, set: 'N' });
    const plan = [0, 1, 2].flatMap((p) => [cell(p, 'A0'), cell(p, 'A1')]);
    expect(abandonedTail([cell(0, 'A0'), cell(1, 'A0'), cell(2, 'A0'), cell(0, 'A1')], plan).map((c) => `${c.arm}@${c.position}`)).toEqual(['A1@1', 'A1@2']);
  });

  it('every record a surface run writes meets the contract', async () => {
    const { out } = isolate('contract');
    const r = makeRepo();
    const s = spec(r, [family('f1', [lesson('f1-l1', 'Write the lesson file')])], [
      teach(r, 't1', 'f1-l1', 'LESSON_BAD MEMWRITE:taught'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'LESSON_BAD'), apply(r, 'a2', 'f1-l1', 'LESSON_OK'),
    ]);
    await run(s, ['A0', 'A1', 'A2'], out);
    const recs = readRecords(out);
    expect(validateCorpus(recs, readPlan(out))).toEqual([]);
    expect(abandonedTail(recs, readPlan(out))).toEqual([]);
  }, 300_000);
});
