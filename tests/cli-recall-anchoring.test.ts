// `hippo recall` anchoring hint, run through cmdRecall in this process: the rings live per process, so a spawned CLI never accumulates history.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { cmdRecall, __resetSessionRecallHistoryCli } from '../src/cli/recall.js';
import { peekSessionRing } from '../src/api/recall-record.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { Layer } from '../src/memory.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { makeRoot } from './_helpers/make-root.js';
import { runInProcess } from './_helpers/run-in-process.js';

// Four phrasings that hash apart and all rank the one seeded memory first.
const Q = ['frobnicate baz quux', 'frobnicate baz different words', 'frobnicate quux yet another', 'frobnicate quux baz once more'] as const;
type Flags = Record<string, string | boolean>;
interface RecallJson { suppressionSummary: { suppressedByInterference: number }; anchoringHint?: { reason: string; memoryId: string } }

let root: string;
let memoryId: string;

function seed(tenantId: string): string {
  const entry = createMemory(`frobnicate baz quux ${tenantId} memory`, { layer: Layer.Buffer, confidence: 'observed', kind: 'raw', tenantId });
  writeEntry(root, entry);
  return entry.id;
}

async function recall(query: string, flags: Flags = { 'session-id': 's1' }): Promise<string> {
  const run = await runInProcess(() => cmdRecall(root, query, flags));
  expect(run.status, run.stderr).toBe(0);
  return run.stdout;
}

async function recallJson(query: string, flags: Flags = { 'session-id': 's1' }): Promise<RecallJson> {
  // SAFETY: --json prints one object carrying these fields; each test asserts the ones it reads.
  return JSON.parse(await recall(query, { ...flags, json: true })) as RecallJson;
}

describe('hippo recall anchoring hint', () => {
  beforeEach(() => {
    root = makeRoot('cli-anchor');
    // A global store that does not exist keeps the recall on the local store alone.
    vi.stubEnv('HIPPO_HOME', join(root, 'no-global'));
    for (const name of ['HIPPO_TENANT', 'HIPPO_SESSION_ID', 'HIPPO_ANCHORING']) vi.stubEnv(name, '');
    __resetSessionRecallHistoryCli();
    memoryId = seed('default');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('prints the anchored_on line above the results on the third distinct query one memory tops, and not again on the fourth', async () => {
    const out: string[] = [];
    for (const query of Q) out.push(await recall(query));

    expect(out[1]).not.toContain('[anchored_on:');
    const hintAt = out[2].indexOf(`[anchored_on: ${memoryId}]`);
    expect(hintAt).toBeGreaterThanOrEqual(0);
    expect(out[2].indexOf('Found 1 memories')).toBeGreaterThan(hintAt);
    expect(out[3]).toContain('Found 1 memories');
    expect(out[3]).not.toContain('[anchored_on:');
  });

  it('--json counts an interference suppression for memory_dominance and none for a repeated query', async () => {
    await recallJson(Q[0]);
    await recallJson(Q[1]);
    const third = await recallJson(Q[2]);
    await recallJson(Q[0], { 'session-id': 's2' });
    const repeat = await recallJson(Q[0], { 'session-id': 's2' });

    expect(third.anchoringHint).toMatchObject({ reason: 'memory_dominance', memoryId });
    expect(third.suppressionSummary.suppressedByInterference).toBe(1);
    expect(repeat.anchoringHint).toMatchObject({ reason: 'query_repeat', memoryId });
    expect(repeat.suppressionSummary.suppressedByInterference).toBe(0);
  });

  it('keys the history by session id, read from --session-id or HIPPO_SESSION_ID', async () => {
    await recallJson(Q[0]);
    await recallJson(Q[1]);
    const otherSession = await recallJson(Q[2], { 'session-id': 's2' });
    vi.stubEnv('HIPPO_SESSION_ID', 's1');
    const sameSessionFromEnv = await recallJson(Q[2], {});

    expect(otherSession.anchoringHint).toBeUndefined();
    expect(sameSessionFromEnv.anchoringHint?.reason).toBe('memory_dominance');
  });

  it('keeps the history per tenant, on the cli surface', async () => {
    await recallJson(Q[0]);
    await recallJson(Q[1]);
    vi.stubEnv('HIPPO_TENANT', 'acme');
    const acmeId = seed('acme');
    await recallJson(Q[2]);

    expect(peekSessionRing('cli', 'default', 's1').map((e) => e.topMemoryId)).toEqual([memoryId, memoryId]);
    expect(peekSessionRing('cli', 'acme', 's1').map((e) => e.topMemoryId)).toEqual([acmeId]);
    expect(peekSessionRing('mcp', 'default', 's1')).toEqual([]);
  });
});
