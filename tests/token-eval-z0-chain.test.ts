// Z0 failure chain (prereg 179-182) and injected-row sources (93) with the fake Claude Code.
import { describe, it, expect, afterEach } from 'vitest';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';
import { contextBlockLines } from '../src/api/context-render.js';
import { injectedRows } from '../scripts/token-eval/surfaces.mjs';
import {
  cleanup, isolate, makeRepo, task, teach, apply, plain, lesson, family, spec, run, readRecords, readLedger, find,
} from './fixtures/z0-harness.js';

/** Teach t1 with `t1`, two plain tasks, then applies a1 (passes its check) and a2; the arms run in one lockstep. */
function chainSpec(r: ReturnType<typeof makeRepo>, t1: string) {
  return spec(r, [family('f1', [lesson('f1-l1', 'Write the lesson file')])], [
    teach(r, 't1', 'f1-l1', t1), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'LESSON_OK'), apply(r, 'a2', 'f1-l1', 'look around only'),
  ]);
}

describe('failure chain on applies', () => {
  afterEach(cleanup);

  it('in A1 a teach that writes the phrase to auto memory gives stored, shown and followed', async () => {
    const { out } = isolate('chain-mem');
    await run(chainSpec(makeRepo(), 'MEMWRITE:remember zq-f1-l1'), ['A1'], out);
    const recs = readRecords(out);
    expect(find(recs, 'A1', 'a1').chain).toEqual({ stored: true, shown: true, followed: true, captured: null, capturedAny: null });
    expect(find(recs, 'A1', 'a2').chain).toMatchObject({ stored: true, shown: true, followed: null });
  }, 300_000);

  it('in A1 with nothing written the chain stops at stored', async () => {
    const { out } = isolate('chain-none');
    await run(chainSpec(makeRepo(), 'look around only'), ['A1'], out);
    expect(find(readRecords(out), 'A1', 'a1').chain).toEqual({ stored: false, shown: false, followed: null, captured: null, capturedAny: null });
  }, 300_000);

  it('a user-level CLAUDE.md holding the phrase counts as shown', async () => {
    const { out } = isolate('chain-user');
    await run(chainSpec(makeRepo(), 'look around only\nUSERMEM:remember zq-f1-l1'), ['A1'], out);
    expect(find(readRecords(out), 'A1', 'a1').chain).toMatchObject({ stored: true, shown: true, followed: true });
  }, 300_000);

  it('A2 records whether hippo captured the teach, A5 never; teach, no-lesson and invalid records carry no chain', async () => {
    const { out } = isolate('chain-capture');
    const r = makeRepo();
    const s = spec(r, [family('f1', [lesson('f1-l1', 'Write the lesson file')])], [
      teach(r, 't1', 'f1-l1', 'CAPTURE_TEACH'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'LESSON_OK'),
      apply(r, 'a2', 'f1-l1', 'look around only', { setup: 'exit 1' }),
    ]);
    await run(s, ['A2', 'A5'], out);
    const recs = readRecords(out);
    expect(find(recs, 'A2', 'a1').chain).toMatchObject({ captured: true, capturedAny: true });
    expect(find(recs, 'A5', 'a1').chain).toMatchObject({ captured: null, capturedAny: null });
    for (const id of ['t1', 'n1', 'a2']) for (const arm of ['A2', 'A5']) expect(find(recs, arm, id).chain, `${arm} ${id}`).toBeUndefined();
    expect(find(recs, 'A2', 'a2').invalid).toBe('setup');
  }, 300_000);

  it('in A2 a hippo row holding the phrase that the hook adds to session 1 counts as shown', async () => {
    const { out } = isolate('chain-hook');
    const r = makeRepo();
    const s = spec(r, [family('f1', [lesson('f1-l1', 'Write the lesson file')])], [
      teach(r, 't1', 'f1-l1', 'PLANT:remember zq-f1-l1 when writing'), plain(r, 'n1'), plain(r, 'n2'),
      apply(r, 'a1', 'f1-l1', 'LESSON_OK remember when writing'), apply(r, 'a2', 'f1-l1', 'look around only'),
    ]);
    await run(s, ['A2'], out);
    expect(find(readRecords(out), 'A2', 'a1').chain).toMatchObject({ stored: true, shown: true, followed: true });
  }, 300_000);

  it('A2 without a captured teach gives captured false', async () => {
    const { out } = isolate('chain-nocapture');
    await run(chainSpec(makeRepo(), 'look around only'), ['A2'], out);
    expect(find(readRecords(out), 'A2', 'a1').chain).toMatchObject({ captured: false, capturedAny: false });
  }, 300_000);
});

describe('injected-row sources', () => {
  afterEach(cleanup);

  it('counts imported rows among the bullets hippo printed, global and truncated ones included', () => {
    const imported = createMemory('the build   needs node 22', { source: 'agent-memory:claude-code:p/n.md#ab12', baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    const cut = createMemory(`${'long imported note '.repeat(10)}[truncated]`, { source: 'agent-memory:codex:m/x.md#cd34', baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    const native = createMemory('run the tests with vitest', { source: 'cli', baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    const bullet = (entry: typeof native, isGlobal: boolean) => contextBlockLines([{ entry, isGlobal }], 0, 'observe').slice(1).join('\n');
    const text = ['## Project Memory (3 entries, 40 tokens)\n', bullet(imported, true), bullet(cut, false), bullet(native, false)].join('\n');
    const got = injectedRows([text], [{ ...imported, global: true }, { ...cut, global: false }, { ...native, global: false }]);
    expect(got.counts).toMatchObject({ rows: 3, importedRows: 2, unmatched: 0, ambiguous: 0 });
    expect(got.counts.importedChars).toBeLessThan(got.counts.chars);
    expect(got.rows.map((x: { prefix: string; global: boolean }) => [x.prefix, x.global])).toEqual([
      ['agent-memory:claude-code', true], ['agent-memory:codex', false], ['cli', false],
    ]);
  });

  it('in A2 an imported auto-memory note injected into a later session is counted and its source prefix logged', async () => {
    const { out } = isolate('injected');
    const r = makeRepo();
    const s = spec(r, [], [
      task(r, 'n1', 'NOTE:the frobnicate helper lives in quux.js\nIMPORT'), task(r, 'n2', 'where does the frobnicate helper in quux.js live'),
    ]);
    await run(s, ['A2'], out);
    expect(find(readRecords(out), 'A2', 'n2').injectedRows?.importedRows).toBeGreaterThanOrEqual(1);
    const line = readLedger(out).find((l) => l.when === 'injected' && l.taskId === 'n2');
    expect(line?.rows?.map((x) => x.prefix)).toContain('agent-memory:claude-code');
  }, 300_000);
});
