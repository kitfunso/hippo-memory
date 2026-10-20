// contextGet with the delivery observer attached: same result, no writes, and a reason for every rejected candidate.
import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createMemory, type MemoryEntry, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { contextGet, type ContextOptions } from '../../src/api/index.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { loadConfig, type HippoConfig } from '../../src/base/config/config.js';
import { createDeliveryRecorder, type DeliveryFault, type DeliveryRecorder } from '../../src/api/delivery-recorder.js';
import type { DeliveryEventInput, DeliveryEventType } from '../../src/base/session/delivery.js';
import { blockHash } from '../../src/base/util/token-text.js';
import { flushDeliveryRecorder } from '../../src/api/prompt-hook.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import type { Ledger } from '../../src/store/port.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const PROJECT = 'proj-a';
const PROMPT = 'how should the postgres migration rollback plan work';

let tmpRoot: string;
let local: string;
let globalRoot: string;
let ctx: FullContext;

function seed(root: string, content: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  const entry = {
    ...createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
    originProject: PROJECT,
    ...extra,
  };
  writeEntry(root, entry);
  return entry;
}

function configure(pinnedInject: Partial<HippoConfig['pinnedInject']>): void {
  fs.writeFileSync(
    path.join(local, 'config.json'),
    JSON.stringify({
      pinnedInject: { promptRecallThreshold: 0.1, promptRecallMinShared: 1, ...pinnedInject },
    }),
  );
  // The root loads config once per command, so the next call sees the file through a reloaded ctx.config.
  ctx = { ...ctx, config: loadConfig(local) };
}

function recorder(fault?: DeliveryFault, ledger: Ledger = sqliteStore(local).ledger): DeliveryRecorder {
  return createDeliveryRecorder({
    fault,
    ledger,
    storeHash: 'aaaaaaaaaaaaaaaa',
    writeStore: 'local',
    tenantId: 'default',
    stdinText: JSON.stringify({ session_id: 's1', prompt: PROMPT, hook_event_name: 'UserPromptSubmit' }),
  });
}

function eventOf(rec: DeliveryRecorder): DeliveryEventInput {
  const input = rec.takeEvent();
  if (input === null) throw new Error('recorder built nothing');
  return input;
}

const baseOpts: ContextOptions = {
  pinnedOnly: true,
  includeRecent: 5,
  currentProject: PROJECT,
  prompt: PROMPT,
  currentSessionId: 's1',
};

/** Runs contextGet without and then with an observer, asserts both results match, and returns the event. */
async function observed(opts: ContextOptions = baseOpts): Promise<DeliveryEventInput> {
  const without = await contextGet(ctx, opts);
  const rec = recorder();
  const withObs = await contextGet(ctx, { ...opts, deliveryObserver: rec });
  expect(JSON.stringify(withObs)).toBe(JSON.stringify(without));
  expect(withObs).toEqual(without);
  return eventOf(rec);
}

function seedMixedStore(): void {
  seed(local, 'pinned rule: always run the postgres migration tests before merging', { pinned: true });
  seed(local, 'pinned rule: the deploy script lives in the ops folder for every release', { pinned: true });
  seed(local, 'the postgres migration script needs a rollback plan before deploy', {
    created: '2026-05-01T00:00:00.000Z',
  });
  seed(local, 'a migration rollback plan should name the owner and the restore point', {
    created: '2026-05-02T00:00:00.000Z',
  });
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
  vi.stubEnv('HIPPO_FAKE_NOW', '2026-07-01T00:00:00.000Z');
  tmpRoot = makeRoot('delivery-recorder', { init: false });
  local = path.join(tmpRoot, 'local', '.hippo');
  globalRoot = path.join(tmpRoot, 'global');
  fs.mkdirSync(local, { recursive: true });
  fs.mkdirSync(globalRoot, { recursive: true });
  initTestStore(local);
  initTestStore(globalRoot);
  vi.stubEnv('HIPPO_HOME', globalRoot);
  ctx = apiCtx(local, 'default', { subject: 'cli', role: 'admin' });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.stubEnv('HIPPO_HOME', undefined);
  vi.stubEnv('HIPPO_FAKE_NOW', undefined);
});

describe('the observer never changes contextGet', () => {
  const scenarios: Array<[string, ContextOptions, boolean]> = [
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
        const result = await contextGet(ctx, opts);
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
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const without = await contextGet(ctx, baseOpts);
    const rec = recorder('observe');
    expect(await contextGet(ctx, { ...baseOpts, deliveryObserver: rec })).toEqual(without);
    expect(rec.takeEvent()).toBeNull();
    expect(String(err.mock.calls[0][0])).toMatch(/^\[hippo\] warn: delivery ledger skipped: recorder failed: /);
  });

  it("lets admit's own throw through and counts a rejected row once however often it is admitted", () => {
    const rec = recorder();
    const entry = createMemory('a memory the admit predicate will see twice', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    });
    expect(() =>
      rec.watchAdmit(() => {
        throw new Error('admit failed');
      })(entry),
    ).toThrow('admit failed');
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
    const big = seed(local, `pinned rule: ${'the deploy checklist covers every service and region '.repeat(8)}`, {
      pinned: true,
    });
    const event = await observed({ ...baseOpts, budget: 40 });
    const row = rowsOf(event).find((c) => c.memoryId === big.id);
    expect([row?.stage, row?.reason, row?.pool]).toEqual(['budget', 'budget', 'pin']);
    // A pin with no wrong marks has strength exactly 1, and the recent pool adds no boost.
    expect(row?.score).toBe(1);
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
    expect([rows.get(weak.id)?.stage, rows.get(weak.id)?.reason, rows.get(weak.id)?.pool]).toEqual([
      'gate',
      'gate-below-threshold',
      'prompt-recall',
    ]);
    // Jaccard over content words: 'postgres' is the one word shared by the prompt's six and the memory's eight.
    expect(rows.get(weak.id)?.score).toBeCloseTo(1 / 13, 10);
  });

  it('scope and quality at eligibility, for prompt-recall candidates the loader returned', async () => {
    configure({ promptRecall: true });
    const foreign = seed(local, 'the postgres migration rollback plan for the billing service', {
      originProject: 'proj-b',
    });
    const junk = seed(local, 'postgres');
    const event = await observed();
    const rows = new Map(rowsOf(event).map((c) => [c.memoryId, c]));
    expect([rows.get(foreign.id)?.stage, rows.get(foreign.id)?.reason]).toEqual(['eligible', 'scope']);
    expect([rows.get(junk.id)?.stage, rows.get(junk.id)?.reason]).toEqual(['eligible', 'quality']);
  });

  it('quality at load for a low-quality recent row the loader skipped, with prompt recall off', async () => {
    configure({ promptRecall: false });
    seed(local, 'office note 1: the coffee machine schedule changes for team lunch on friday', {
      created: '2026-06-01T00:00:00.000Z',
    });
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
    const other = seed(local, 'pinned rule: the deploy script lives in the ops folder for every release', {
      pinned: true,
    });
    const event = await observed({ ...baseOpts, limit: 1 });
    const kept = (await contextGet(ctx, { ...baseOpts, limit: 1 })).entries.map((e) => e.entry.id);
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
    for (let i = 0; i < 3; i++) {
      seed(local, `other project note ${i}: the billing export runs every night at two`, { originProject: 'proj-b' });
    }
    const event = await observed({ ...baseOpts, includeRecent: 2 });
    expect([event.consideredCount, event.selectedCount, event.rejectedCount, event.rejectedUnlisted]).toEqual([
      6, 2, 4, 4,
    ]);
    expect(rowsOf(event)).toEqual([]);
    expect(event.filteredCount).toBe(3);
  });
});

describe('the event type of a recorder', () => {
  it('R1 takes eventType over a UserPromptSubmit payload', () => {
    const rec = createDeliveryRecorder({
      ledger: sqliteStore(local).ledger,
      storeHash: 'aaaaaaaaaaaaaaaa',
      writeStore: 'local',
      tenantId: 'default',
      eventType: 'pre-compact',
      stdinText: JSON.stringify({ session_id: 's1', prompt: PROMPT, hook_event_name: 'UserPromptSubmit' }),
    });
    expect(eventOf(rec).eventType).toBe('pre-compact');
  });

  it('R2 without eventType keeps the payload inference', () => {
    expect(eventOf(recorder()).eventType).toBe('prompt-submit');
    const manual = createDeliveryRecorder({
      ledger: sqliteStore(local).ledger,
      storeHash: 'aaaaaaaaaaaaaaaa',
      writeStore: 'local',
      tenantId: 'default',
      stdinText: JSON.stringify({ session_id: 's1' }),
    });
    expect(eventOf(manual).eventType).toBe('pinned-manual');
  });
});

describe('prompt facts on a boundary or context row', () => {
  const withPrompt = (eventType?: DeliveryEventType) =>
    createDeliveryRecorder({
      ledger: sqliteStore(local).ledger,
      storeHash: 'aaaaaaaaaaaaaaaa',
      writeStore: 'local',
      tenantId: 'default',
      eventType,
      stdinText: JSON.stringify({ session_id: 's1', prompt: 'secret prompt', hook_event_name: 'UserPromptSubmit' }),
    });

  for (const type of ['pre-compact', 'compact-resume', 'session-end', 'context'] as const) {
    it(`R3 a ${type} row keeps no prompt hash or length although the payload carries a prompt`, () => {
      const event = eventOf(withPrompt(type));
      expect([event.eventType, event.promptHash, event.promptLength]).toEqual([type, null, 0]);
      expect(event.surface).toBe(type === 'context' ? 'context' : 'hook');
    });
  }

  it('R5 a context row keeps the hash of the query it was told and the trace id, which no other call reports', () => {
    const rec = withPrompt('context');
    rec.queried('postgres rollback');
    rec.traced(42);
    const event = eventOf(rec);
    expect([event.queryHash, event.recallTraceId]).toEqual([blockHash('postgres rollback'), 42]);
    expect([eventOf(withPrompt()).queryHash, eventOf(withPrompt()).recallTraceId]).toEqual([null, null]);
  });

  it('R4 a prompt-submit row still carries the prompt hash and length', () => {
    const event = eventOf(withPrompt());
    expect(event.eventType).toBe('prompt-submit');
    expect(event.promptHash).not.toBeNull();
    expect(event.promptLength).toBe(13);
  });
});

describe('the tool-failure recorder', () => {
  const failureRecorder = (eventType: DeliveryEventType, payload: Record<string, string>, fault?: DeliveryFault) =>
    createDeliveryRecorder({
      fault,
      ledger: sqliteStore(local).ledger,
      storeHash: 'aaaaaaaaaaaaaaaa',
      writeStore: 'local',
      tenantId: 'default',
      eventType,
      stdinText: JSON.stringify({ session_id: 's', hook_event_name: 'PostToolUseFailure', ...payload }),
    });

  it('reads tool_use_id trimmed and cut to 128 characters, and a blank one as null', () => {
    expect(eventOf(failureRecorder('tool-failure', { tool_use_id: '  toolu_1  ' })).toolUseId).toBe('toolu_1');
    expect(eventOf(failureRecorder('tool-failure', { tool_use_id: 'x'.repeat(300) })).toolUseId).toBe('x'.repeat(128));
    expect(eventOf(failureRecorder('tool-failure', { tool_use_id: '   ' })).toolUseId).toBeNull();
    expect(eventOf(failureRecorder('tool-failure', {})).toolUseId).toBeNull();
  });

  it('sets the tool call and failure link on tool-failure rows only, with no candidates or counts', () => {
    const rec = failureRecorder('tool-failure', { tool_use_id: 'toolu_1' });
    rec.logged(42);
    const input = eventOf(rec);
    expect([input.eventType, input.surface, input.blockState, input.toolUseId, input.failureId]).toEqual([
      'tool-failure',
      'hook',
      'empty',
      'toolu_1',
      42,
    ]);
    expect([input.candidates, input.consideredCount, input.emittedCount, input.promptHash, input.promptLength]).toEqual(
      [[], 0, 0, null, 0],
    );
    const other = failureRecorder('prompt-submit', { tool_use_id: 'toolu_1', prompt: 'hello' });
    other.logged(42);
    const o = eventOf(other);
    expect([o.toolUseId, o.failureId]).toEqual([null, null]);
  });

  it('logged(null) leaves the link empty', () => {
    const rec = failureRecorder('tool-failure', {});
    rec.logged(null);
    expect(eventOf(rec).failureId).toBeNull();
  });

  it('a throw inside logged marks the recorder broken, so it writes nothing', () => {
    const rec = failureRecorder('tool-failure', { tool_use_id: 'toolu_1' }, 'observe');
    rec.logged(7);
    expect(rec.takeEvent()).toBeNull();
  });
});

describe('a recorder fault at the flush boundary', () => {
  it.each<[DeliveryFault]>([['observe'], ['build'], ['flush']])(
    '%s: flushDeliveryRecorder returns, writes nothing and logs one ledger line',
    async (fault) => {
      const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const ledger = sqliteStore(local).ledger;
      const write = vi.spyOn(ledger, 'writeDeliveryEvent');
      const rec = recorder(fault, ledger);
      rec.queried('a query');
      await expect(flushDeliveryRecorder(rec)).resolves.toBeUndefined();
      expect(write).not.toHaveBeenCalled();
      const lines = err.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('delivery ledger'));
      expect(lines).toHaveLength(1);
    },
  );
});
