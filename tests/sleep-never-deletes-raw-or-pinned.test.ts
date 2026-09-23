// C1 + H10: sleep never auto-deletes a raw or pinned row, keeps a change made while it
// awaits the LLM, and a dry run previews the deletes a real sleep would make.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory, type MemoryEntry } from '../src/memory.js';
import { initStore, writeEntry, readEntry, deleteEntry, loadAllEntries } from '../src/store.js';
import { consolidate } from '../src/consolidate.js';
import { deduplicateStore } from '../src/dedupe.js';
import { sleep, supersede, type Context } from '../src/api.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { queryAuditEvents } from '../src/audit.js';
import { renderSleepResult } from '../src/cli.js';

const DAY = 86_400_000;
const roots: string[] = [];

function newRoot(configJson?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'hippo-c1-'));
  roots.push(root);
  initStore(root);
  if (configJson) writeFileSync(join(root, 'config.json'), configJson);
  return root;
}

const rawRow = (content: string): MemoryEntry =>
  createMemory(content, { kind: 'raw', artifact_ref: 'slack://T1/C1/1.0', owner: 'user:U1' });
const ctxFor = (hippoRoot: string): Context =>
  ({ hippoRoot, tenantId: 'default', actor: { subject: 'sleep-test', role: 'admin' } });
const sixtyDaysOn = (): Date => new Date(Date.now() + 60 * DAY);
const CACHE_FACT = 'the build cache lives in /var/cache/hippo on the CI runners';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('C1: consolidate never deletes a raw row', () => {
  it.each([false, true])('memoryValue.enabled=%s: the decayed raw row stays, the plain row goes', async (mv) => {
    const root = newRoot(JSON.stringify({ memoryValue: { enabled: mv } }));
    const raw = rawRow('slack message: the deploy moved to friday');
    const plain = createMemory('an ordinary memory that should decay away');
    writeEntry(root, raw);
    writeEntry(root, plain);

    await consolidate(root, { now: sixtyDaysOn() });

    expect(readEntry(root, raw.id)?.kind).toBe('raw');
    expect(readEntry(root, plain.id)).toBeNull();
    await expect(consolidate(root, { now: sixtyDaysOn() })).resolves.toBeDefined();
  });
});

describe('H10: the sleep audit and dedup respect raw and pinned rows', () => {
  it('audit deletes only the plain junk row and logs the caller and a reason', async () => {
    const root = newRoot();
    const raw = rawRow('yes!');
    const pinned = createMemory('ok ok', { pinned: true });
    const plain = createMemory('nope');
    for (const e of [raw, pinned, plain]) writeEntry(root, e);

    const result = await sleep(ctxFor(root), { noShare: true });

    expect(readEntry(root, raw.id)).not.toBeNull();
    expect(readEntry(root, pinned.id)).not.toBeNull();
    expect(readEntry(root, plain.id)).toBeNull();
    expect(result.audit).toEqual({ errorsRemoved: 1, warningCount: 2 });
    const db = openHippoDb(root);
    try {
      const forgets = queryAuditEvents(db, { tenantId: 'default', op: 'forget' });
      expect(forgets.map((f) => f.targetId)).toEqual([plain.id]);
      expect(forgets[0]!.actor).toBe('sleep-test');
      expect(String(forgets[0]!.metadata.reason)).toMatch(/^sleep-audit: /);
    } finally {
      closeHippoDb(db);
    }
  });

  it('dedup keeps a pinned duplicate', () => {
    const root = newRoot();
    const keeper = createMemory(CACHE_FACT);
    const pinnedCopy = { ...createMemory(CACHE_FACT, { pinned: true }), strength: 0.5 };
    writeEntry(root, keeper);
    writeEntry(root, pinnedCopy);

    deduplicateStore(root);

    expect(readEntry(root, keeper.id)).not.toBeNull();
    expect(readEntry(root, pinnedCopy.id)).not.toBeNull();
  });

  it('a dry run previews the dedup and audit deletes and deletes nothing', async () => {
    const root = newRoot();
    const rows = [createMemory('nope'), createMemory(CACHE_FACT), { ...createMemory(CACHE_FACT), strength: 0.5 }];
    for (const e of rows) writeEntry(root, e);

    const result = await sleep(ctxFor(root), { dryRun: true, noShare: true });

    expect(result.deduped?.removed).toBe(1);
    expect(result.audit).toEqual({ errorsRemoved: 1, warningCount: 0 });
    expect(result.shared).toBeUndefined();
    expect(loadAllEntries(root)).toHaveLength(3);
  });

  it('the dry-run render says "would" instead of "removed"', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
    renderSleepResult({
      active: 3, removed: 0, mergedEpisodic: 0, newSemantic: 0, dryRun: true, details: [],
      deduped: { removed: 1, semDups: 0, epiDups: 1, crossDups: 0 },
      audit: { errorsRemoved: 1, warningCount: 0 },
    });
    const out = lines.join('\n');
    expect(out).toContain('Would dedupe 1 duplicates');
    expect(out).toContain('Audit: would remove 1 junk memories');
    expect(out).not.toMatch(/Deduped|removed 1 junk/);
  });
});

describe('C1: a row changed while sleep awaits the LLM keeps the change', () => {
  it('a mid-sleep pin, forget and supersede all survive the batch flush', async () => {
    const root = newRoot();
    const condemned = createMemory('a fact that decays below the threshold by day sixty');
    const forgotten = createMemory('the staging cluster restarts every sunday at noon', { baseHalfLifeDays: 30 });
    const replaced = createMemory('invoices are exported as csv files on the first monday', { baseHalfLifeDays: 30 });
    for (const e of [condemned, forgotten, replaced]) writeEntry(root, e);

    let calls = 0;
    const fetcher = vi.fn<typeof fetch>(async () => {
      if (calls++ === 0) {
        writeEntry(root, { ...readEntry(root, condemned.id)!, pinned: true });
        deleteEntry(root, forgotten.id);
        supersede(ctxFor(root), replaced.id, 'invoices are exported as parquet files on the first monday');
      }
      return new Response(JSON.stringify({ content: [{ text: '[]' }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('real network call in a test'); }));
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-not-a-key');

    await consolidate(root, { now: sixtyDaysOn(), fetcher });

    expect(fetcher).toHaveBeenCalled();
    expect(readEntry(root, condemned.id)?.pinned).toBe(true);
    expect(readEntry(root, forgotten.id)).toBeNull();
    expect(readEntry(root, replaced.id)?.superseded_by).toBeTruthy();
  });
});
