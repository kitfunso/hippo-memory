// Z0 set X gates through runAll: G1 reads and hook text, G3 in Codex state, the X2 chain, and the rollout classes (E6 plan tests 17-19, 25).
import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, makeRepo, find, tmp } from './fixtures/z0-harness.js';
import { xRun, xTrio, xIsolate, xRecords } from './fixtures/z0-codex-harness.js';
import type { XRecord } from './fixtures/z0-codex-harness.js';

afterEach(cleanup);

const fwd = (p: string) => p.replaceAll('\\', '/');
const classes = (r: XRecord) => (r.voidHits ?? []).map((h) => h.class);
const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('G1 on a Codex apply (test 17)', () => {
  it('voids a past rollout and the operator\'s .codex, passes memories/ and the run\'s own ~, and reads hook text and quoted rollouts', async () => {
    const { out, home, op } = xIsolate('g1');
    const operatorAgents = fwd(join(home, '.codex', 'AGENTS.md'));
    const prompts = {
      'a-xa': ['READ:{CODEX_HOME}/sessions/past-rollout.jsonl', 'READ:{CODEX_HOME}/memories/notes.md', `READ:${operatorAgents}`, 'READ:~/.codex/AGENTS.md'].join('\n'),
      'a-xb': 'READ:old.jsonl\nHOOKCTX:<!-- hippo:start --> hint',
    };
    const r = makeRepo({ 'old.jsonl': `${JSON.stringify({ type: 'session_meta', payload: { id: 'old-thread' } })}\n` });
    await xRun(xTrio(r, prompts), ['X1'], out, op);
    const recs = xRecords(out);
    const a = find(recs, 'X1', 'a-xa');
    expect(a.void).toBe('read');
    expect(classes(a)).toEqual(['past-rollout', 'operator']);
    expect(a.voidHits?.[1].path?.toLowerCase()).toBe(operatorAgents.toLowerCase());
    const b = find(recs, 'X1', 'a-xb');
    expect(b.voidHits?.map((h) => `${h.reason}/${h.class}`)).toEqual(['read/transcript-content', 'hippo-text/hook', 'hippo-text/rollout']);
    expect(find(recs, 'X1', 'a-xc').void).toBeNull();
  }, 240_000);

  it('does not void a hippo hook context in X2', async () => {
    const { out, op } = xIsolate('g1x2');
    await xRun(xTrio(makeRepo(), { 'a-xb': 'HOOKCTX:<!-- hippo:start --> hint' }), ['X2'], out, op);
    const b = find(xRecords(out), 'X2', 'a-xb');
    expect([b.tool, b.void, b.voidHits ?? []]).toEqual(['codex', null, []]);
  }, 240_000);
});

describe('G3 on Codex state (test 18)', () => {
  it('finds a key phrase in a memories database WAL file before its teach, and voids the rest of the run', async () => {
    const { out, op } = xIsolate('g3');
    const prompts = { 't-xa': `LESSON_BAD\nAPPEND:{RUN}/codex-home/memories_1.sqlite-wal:{B64:${b64('the zq-xb-l1 rule')}}` };
    await xRun(xTrio(makeRepo(), prompts), ['X1'], out, op);
    const recs = xRecords(out);
    const t = find(recs, 'X1', 't-xb');
    expect(t.invalid).toBe('leak');
    expect(t.leakHits?.map((h) => [h.lessonId, h.surface])).toEqual([['xb-l1', 'codexState']]);
    expect(t.leakHits?.[0].path).toMatch(/memories_1\.sqlite/);
    expect(['t-xc', 'a-xa', 'b-xc'].map((id) => find(recs, 'X1', id).invalid)).toEqual(['leak', 'leak', 'leak']);
  }, 240_000);

  it('finds a key phrase planted in the run\'s codex-home memories before the teach', async () => {
    const { out, op } = xIsolate('g3mem');
    const prompts = { 't-xa': `LESSON_BAD\nAPPEND:{RUN}/codex-home/memories/notes.md:{B64:${b64('the zq-xb-l1 rule')}}` };
    await xRun(xTrio(makeRepo(), prompts), ['X1'], out, op);
    const recs = xRecords(out);
    const t = find(recs, 'X1', 't-xb');
    expect(t.invalid).toBe('leak');
    expect(t.leakHits?.map((h) => [h.lessonId, h.surface])).toEqual([['xb-l1', 'codexMemories']]);
    expect(['a-xa', 'b-xc'].map((id) => find(recs, 'X1', id).invalid)).toEqual(['leak', 'leak']);
  }, 240_000);

  it('counts a key phrase in a memories database WAL file in the stored check', async () => {
    const { out, op } = xIsolate('storedwal');
    const prompts = { 't-xa': `LESSON_BAD\nAPPEND:{RUN}/codex-home/memories_1.sqlite-wal:{B64:${b64('the zq-xa-l1 rule')}}` };
    await xRun(xTrio(makeRepo(), prompts), ['X1'], out, op);
    expect(find(xRecords(out), 'X1', 'a-xa').chain).toMatchObject({ stored: true, shown: false });
  }, 240_000);
});

describe('the X2 chain (test 19)', () => {
  it('copies captured from the teach and takes shown from a hippo hook context, which X2 may hold', async () => {
    const { out, op } = xIsolate('x2chain');
    const prompts = { 't-xa': 'LESSON_BAD\nCAPTURE_TEACH', 'a-xa': `HOOKCTX:<!-- hippo:start --> {B64:${b64('the zq-xa-l1 rule')}}` };
    await xRun(xTrio(makeRepo(), prompts), ['X2'], out, op);
    const a = find(xRecords(out), 'X2', 'a-xa');
    expect([a.tool, a.invalid, a.void]).toEqual(['codex', null, null]);
    expect(a.chain).toMatchObject({ captured: true, shown: true });
  }, 240_000);

  it('counts hook rows for the Codex thread and the wrapper capture line for that thread only', async () => {
    const { out, op } = xIsolate('x2hooks');
    const prompts = { 'a-xa': 'HOOKROW\nWRAPLOG', 'b-xa': 'WRAPLOG_OTHER' };
    await xRun(xTrio(makeRepo(), prompts), ['X2'], out, op);
    const recs = xRecords(out);
    const a = find(recs, 'X2', 'a-xa');
    expect([a.codexHooksFired?.injections, a.codexInternalHooksFired, a.codexWrapperCaptured]).toEqual([1, null, true]);
    const b = find(recs, 'X2', 'b-xa');
    expect([b.codexHooksFired?.injections, b.codexWrapperCaptured]).toEqual([0, false]);
  }, 240_000);
});

describe('rollout classes through the runner (test 25)', () => {
  it('prices a child, keeps a memory thread unpriced and outside-only, and gives a stray the full read check', async () => {
    const { out, op } = xIsolate('classes');
    const canary = `zq-canary-${Date.now()}`;
    const canaryFile = join(tmp('z0-canary-'), 'canary.txt');
    writeFileSync(canaryFile, `${canary}\n`);
    const prompts = { 'a-xa': 'CHILD', 'b-xa': 'MEMGEN', 'a-xb': 'MEMGEN\nSTRAY', 'b-xb': `MEMGEN\nMEMGEN_CANARY:${fwd(canaryFile)}` };
    await xRun(xTrio(makeRepo(), prompts), ['X1'], out, op, { codexInternalSources: ['z0-memgen'], canaries: [canary] });
    const recs = xRecords(out);
    const child = find(recs, 'X1', 'a-xa');
    expect(child.usage?.firstSession).toEqual({ inputTokens: 700, cacheWriteTokens: 0, cacheReadTokens: 1600, outputTokens: 150 });
    expect([child.turns, child.void, classes(child)]).toEqual([3, 'read', ['past-rollout']]);
    const mem = find(recs, 'X1', 'b-xa');
    expect([mem.void, mem.usage?.firstSession.inputTokens, mem.codexStrayRollouts]).toEqual([null, 500, 0]);
    expect(mem.codexInternalUsage?.usage).toEqual({ inputTokens: 200, cacheWriteTokens: 0, cacheReadTokens: 100, outputTokens: 30 });
    const stray = find(recs, 'X1', 'a-xb');
    expect([stray.void, classes(stray), stray.codexStrayRollouts]).toEqual(['read', ['past-rollout'], 1]);
    expect(find(recs, 'X1', 'b-xb').void).toBe('operator-canary');
    // X1 has no wrapper log and no hippo store.
    expect(recs.filter((r) => r.tool === 'codex').map((r) => [r.codexWrapperCaptured, r.codexHooksFired])).toEqual(Array(6).fill([false, null]));
  }, 240_000);

  it('counts the child thread\'s hook row in codexHooksFired and a memory thread\'s apart', async () => {
    const { out, op } = xIsolate('classhooks');
    const prompts = { 'a-xa': 'CHILD\nHOOKROW\nHOOKROW_CHILD', 'b-xa': 'MEMGEN\nHOOKROW_MEMGEN' };
    await xRun(xTrio(makeRepo(), prompts), ['X2'], out, op, { codexInternalSources: ['z0-memgen'] });
    const recs = xRecords(out);
    const a = find(recs, 'X2', 'a-xa');
    expect([a.codexHooksFired?.injections, a.codexInternalHooksFired]).toEqual([2, null]);
    const m = find(recs, 'X2', 'b-xa');
    expect([m.codexHooksFired?.injections, m.codexInternalHooksFired?.injections]).toEqual([0, 1]);
  }, 240_000);
});
