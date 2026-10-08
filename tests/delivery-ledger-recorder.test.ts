// getContext with the delivery observer attached: same result, no writes, and a reason for every rejected candidate.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory, type MemoryEntry, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { getContext, type Context, type ContextOpts } from '../src/api.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { _resetAblationCacheForTests } from '../src/ablation.js';
import type { HippoConfig } from '../src/config.js';
import { _setDeliveryFaultForTests, createDeliveryRecorder, type DeliveryEventInput, type DeliveryRecorder } from '../src/delivery-recorder.js';

const PROJECT = 'proj-a';
const PROMPT = 'how should the postgres migration rollback plan work';

let tmpRoot: string;
let local: string;
let globalRoot: string;
let ctx: Context;

function seed(root: string, content: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  const entry = { ...createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), origin_project: PROJECT, ...extra };
  writeEntry(root, entry);
  return entry;
}

function configure(pinnedInject: Partial<HippoConfig['pinnedInject']>): void {
  fs.writeFileSync(path.join(local, 'config.json'), JSON.stringify({
    pinnedInject: { promptRecallThreshold: 0.1, promptRecallMinShared: 1, ...pinnedInject },
  }));
}

function recorder(): DeliveryRecorder {
  return createDeliveryRecorder({
    root: local, storeHash: 'aaaaaaaaaaaaaaaa', writeStore: 'local', tenantId: 'default',
    stdinText: JSON.stringify({ session_id: 's1', prompt: PROMPT, hook_event_name: 'UserPromptSubmit' }),
  });
}

function eventOf(rec: DeliveryRecorder): DeliveryEventInput {
  let input: DeliveryEventInput | null = null;
  rec.flush((i) => { input = i; return 1; });
  if (input === null) throw new Error('recorder wrote nothing');
  return input;
}

const baseOpts: ContextOpts = { pinnedOnly: true, includeRecent: 5, currentProject: PROJECT, prompt: PROMPT, currentSessionId: 's1' };

/** Runs getContext without and then with an observer, asserts both results match, and returns the event. */
async function observed(opts: ContextOpts = baseOpts): Promise<DeliveryEventInput> {
  const without = await getContext(ctx, opts);
  const rec = recorder();
  const withObs = await getContext(ctx, { ...opts, deliveryObserver: rec });
  expect(JSON.stringify(withObs)).toBe(JSON.stringify(without));
  expect(withObs).toEqual(without);
  return eventOf(rec);
}

function seedMixedStore(): void {
  seed(local, 'pinned rule: always run the postgres migration tests before merging', { pinned: true });
  seed(local, 'pinned rule: the deploy script lives in the ops folder for every release', { pinned: true });
  seed(local, 'the postgres migration script needs a rollback plan before deploy', { created: '2026-05-01T00:00:00.000Z' });
  seed(local, 'a migration rollback plan should name the owner and the restore point', { created: '2026-05-02T00:00:00.000Z' });
  for (let i = 0; i < 6; i++) {
    seed(local, `office note ${i}: the coffee machine schedule changes for team lunch on friday`, {
      created: `2026-06-0${i + 1}T00:00:00.000Z`,
    });
  }
  seed(globalRoot, 'global habit: write the postgres rollback steps into the release ticket');
}

function storeCounts(root: string): string {
  const db = openHippoDb(root);
  try {
    const tables = ['recall_traces', 'delivery_events', 'delivery_candidates', 'token_ledger'];
    // SAFETY: each query is a single COUNT(*) aliased `c`; the memories query names its three columns.
    const counts = tables.map((t) => (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c);
    const touched = db.prepare('SELECT id, retrieval_count, last_retrieved FROM memories ORDER BY id').all();
    return JSON.stringify({ counts, touched });
  } finally {
    closeHippoDb(db);
  }
}

beforeEach(() => {
  process.env.HIPPO_FAKE_NOW = '2026-07-01T00:00:00.000Z';
  _resetAblationCacheForTests();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-delivery-recorder-'));
  local = path.join(tmpRoot, 'local', '.hippo');
  globalRoot = path.join(tmpRoot, 'global');
  fs.mkdirSync(local, { recursive: true });
  fs.mkdirSync(globalRoot, { recursive: true });
  initStore(local);
  initStore(globalRoot);
  process.env.HIPPO_HOME = globalRoot;
  ctx = { hippoRoot: local, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.HIPPO_HOME;
  delete process.env.HIPPO_FAKE_NOW;
  _setDeliveryFaultForTests(null);
  _resetAblationCacheForTests();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('the observer never changes getContext', () => {
  const scenarios: Array<[string, ContextOpts, boolean]> = [
    ['include-recent 5', baseOpts, true],
    ['budget pressure', { ...baseOpts, budget: 40 }, true],
    ['an empty store', baseOpts, false],
  ];
  for (const promptRecall of [true, false]) {
    for (const [label, opts, seeded] of scenarios) {
      it(`returns the same result with promptRecall ${promptRecall ? 'on' : 'off'} and ${label}`, async () => {
        configure({ promptRecall });
        if (seeded) seedMixedStore();
        const event = await observed(opts);
        const result = await getContext(ctx, opts);
        expect(event.selectedCount).toBe(result.entries.length);
        expect(event.consideredCount).toBe(event.selectedCount + event.rejectedCount);
        expect(event.promptRecall).toBe(promptRecall);
      });
    }
  }

  it('writes nothing to either store and touches no retrieval stats', async () => {
    configure({ promptRecall: true });
    seedMixedStore();
    const before = [storeCounts(local), storeCounts(globalRoot)];
    await observed();
    expect([storeCounts(local), storeCounts(globalRoot)]).toEqual(before);
  });

  it('a throwing observer leaves the result the same and writes nothing at flush', async () => {
    configure({ promptRecall: true });
    seedMixedStore();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    _setDeliveryFaultForTests('observe');
    const without = await getContext(ctx, baseOpts);
    const rec = recorder();
    expect(await getContext(ctx, { ...baseOpts, deliveryObserver: rec })).toEqual(without);
    const write = vi.fn(() => 1);
    rec.flush(write);
    expect(write).not.toHaveBeenCalled();
    expect(String(err.mock.calls[0][0])).toMatch(/^\[hippo\] delivery ledger skipped: recorder failed: /);
  });

  it("lets admit's own throw through and counts a rejected row once however often it is admitted", () => {
    const rec = recorder();
    const entry = createMemory('a memory the admit predicate will see twice', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    expect(() => rec.watchAdmit(() => { throw new Error('admit failed'); })(entry)).toThrow('admit failed');
    const refuse = rec.watchAdmit(() => false);
    expect([refuse(entry), refuse(entry)]).toEqual([false, false]);
    expect(eventOf(rec).filteredCount).toBe(1);
  });
});

describe('rejection reasons', () => {
  const rowsOf = (event: DeliveryEventInput) => event.candidates.filter((c) => c.outcome === 'rejected');

  it('budget, with the score and price that missed', async () => {
    configure({ promptRecall: false });
    seed(local, 'pinned rule: always run the postgres migration tests before merging', { pinned: true });
    const big = seed(local, `pinned rule: ${'the deploy checklist covers every service and region '.repeat(8)}`, { pinned: true });
    const event = await observed({ ...baseOpts, budget: 40 });
    const row = rowsOf(event).find((c) => c.memoryId === big.id);
    expect([row?.stage, row?.reason, row?.pool]).toEqual(['budget', 'budget', 'pin']);
    expect(row?.score).toBeGreaterThan(0);
    expect(row?.tokens).toBeGreaterThan(40);
  });

  it('gate-below-threshold with its overlap score, and gate-max-items past the item cap', async () => {
    configure({ promptRecall: true, promptRecallMinShared: 2, promptRecallMaxItems: 1 });
    seed(local, 'the postgres migration script needs a rollback plan before deploy');
    const second = seed(local, 'a migration rollback plan should name the owner and the restore point');
    const weak = seed(local, 'postgres connection pooling settings need tuning for the reporting cluster');
    const event = await observed();
    const rows = new Map(rowsOf(event).map((c) => [c.memoryId, c]));
    expect([rows.get(second.id)?.stage, rows.get(second.id)?.reason]).toEqual(['gate', 'gate-max-items']);
    expect([rows.get(weak.id)?.stage, rows.get(weak.id)?.reason, rows.get(weak.id)?.pool]).toEqual(['gate', 'gate-below-threshold', 'prompt-recall']);
    expect(rows.get(weak.id)?.score).toBeGreaterThan(0);
  });

  it('scope and quality at eligibility, for prompt-recall candidates the loader returned', async () => {
    configure({ promptRecall: true });
    const foreign = seed(local, 'the postgres migration rollback plan for the billing service', { origin_project: 'proj-b' });
    const junk = seed(local, 'postgres');
    const event = await observed();
    const rows = new Map(rowsOf(event).map((c) => [c.memoryId, c]));
    expect([rows.get(foreign.id)?.stage, rows.get(foreign.id)?.reason]).toEqual(['eligible', 'scope']);
    expect([rows.get(junk.id)?.stage, rows.get(junk.id)?.reason]).toEqual(['eligible', 'quality']);
  });

  it('quality at load for a low-quality recent row the loader skipped, with prompt recall off', async () => {
    configure({ promptRecall: false });
    seed(local, 'office note 1: the coffee machine schedule changes for team lunch on friday', { created: '2026-06-01T00:00:00.000Z' });
    const junk = seed(local, 'postgres', { created: '2026-06-02T00:00:00.000Z' });
    const event = await observed();
    const row = rowsOf(event).find((c) => c.memoryId === junk.id);
    expect([row?.stage, row?.reason, row?.pool, row?.sourceStore]).toEqual(['load', 'quality', 'recent', 'local']);
    expect([event.filteredCount, event.selectedCount]).toEqual([1, 1]);
  });

  it('duplicate for an unpinned copy of a pin, and limit past the caller cap', async () => {
    configure({ promptRecall: false });
    const text = 'pinned rule: always run the postgres migration tests before merging';
    const pin = seed(local, text, { pinned: true });
    const copy = seed(local, text);
    const other = seed(local, 'pinned rule: the deploy script lives in the ops folder for every release', { pinned: true });
    const event = await observed({ ...baseOpts, limit: 1 });
    const kept = (await getContext(ctx, { ...baseOpts, limit: 1 })).entries.map((e) => e.entry.id);
    const cut = [pin.id, other.id].filter((id) => !kept.includes(id));
    const rows = new Map(rowsOf(event).map((c) => [c.memoryId, c]));
    expect([rows.get(copy.id)?.stage, rows.get(copy.id)?.reason]).toEqual(['load', 'duplicate']);
    expect(cut).toHaveLength(1);
    expect([rows.get(cut[0])?.stage, rows.get(cut[0])?.reason]).toEqual(['limit', 'limit']);
  });

  it('counts loaded rows past the recent take as rejected but unlisted, and admit refusals as filtered', async () => {
    configure({ promptRecall: false });
    for (let i = 0; i < 6; i++) {
      seed(local, `office note ${i}: the coffee machine schedule changes for team lunch on friday`, {
        created: `2026-06-0${i + 1}T00:00:00.000Z`,
      });
    }
    for (let i = 0; i < 3; i++) seed(local, `other project note ${i}: the billing export runs every night at two`, { origin_project: 'proj-b' });
    const event = await observed({ ...baseOpts, includeRecent: 2 });
    expect([event.consideredCount, event.selectedCount, event.rejectedCount, event.rejectedUnlisted]).toEqual([6, 2, 4, 4]);
    expect(rowsOf(event)).toEqual([]);
    expect(event.filteredCount).toBe(3);
  });
});
