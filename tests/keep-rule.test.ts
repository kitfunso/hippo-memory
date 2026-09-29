// A row tagged with the compaction tag whose source starts with the compaction prefix is kept for good: never auto-deleted,
// decayed away or made dormant. The tag alone is not enough, since merge copies source tags onto rows sourced 'consolidation'.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTO_DELETABLE_SQL, COMPACTION_MEMORY_TAG, COMPACTION_SOURCE_PREFIX, KEEP_PAIRS, canAutoDelete, createMemory, type MemoryEntry,
} from '../src/memory.js';
import {
  batchWriteAndDelete, deleteEntry, initStore, listMemoryConflicts, loadAllEntries, readEntry, writeEntry,
} from '../src/store.js';
import { consolidate } from '../src/consolidate.js';
import { deduplicateStore } from '../src/dedupe.js';
import { auditMemory } from '../src/audit.js';
import { closeHippoDb, openHippoDb } from '../src/db.js';
import { NO_MERGE_TAGS } from '../src/shared.js';
import { forget, listDormant, sleep, supersede, type Context } from '../src/api.js';

/** Sleep and decay here run on the pre-1.46 7-day base, so memories fade within the test's horizon. */
const createMemory7 = (content: string, options: Parameters<typeof createMemory>[1] = {}) => createMemory(content, { baseHalfLifeDays: 7, ...options });

const DAY = 86_400_000;
const TAG = COMPACTION_MEMORY_TAG;
const PREFIX = COMPACTION_SOURCE_PREFIX;
const KEPT_SOURCE = `${PREFIX}session-one`;
const RAW_FIELDS = { artifact_ref: 'slack://T1/C1/1.0', owner: 'user:U1' };
const FAKE_KEY = 'sk-ant-' + 'a'.repeat(40);
const roots: string[] = [];

function newRoot(configJson?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'hippo-keep-rule-'));
  roots.push(root);
  initStore(root);
  if (configJson) writeFileSync(join(root, 'config.json'), configJson);
  return root;
}

const ctxFor = (hippoRoot: string): Context => ({ hippoRoot, tenantId: 'default', actor: { subject: 'keep-rule-test', role: 'admin' } });
const sixtyDaysOn = (): Date => new Date(Date.now() + 60 * DAY);
const keptRow = (content: string): MemoryEntry => createMemory7(content, { tags: [TAG], source: KEPT_SOURCE });
const okFetcher = () => vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ content: [{ text: '[]' }] }), { status: 200 }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const KEEP_CASES: ReadonlyArray<{ label: string; tags: string[]; source: string; kept: boolean }> = [
  { label: 'tag and prefix', tags: [TAG], source: KEPT_SOURCE, kept: true },
  { label: 'tag among other tags', tags: ['infra', TAG, 'prod'], source: KEPT_SOURCE, kept: true },
  { label: 'bare prefix as the source', tags: [TAG], source: PREFIX, kept: true },
  { label: 'tag on a merged row', tags: [TAG], source: 'consolidation', kept: false },
  { label: 'prefix without the tag', tags: [], source: KEPT_SOURCE, kept: false },
  { label: 'prefix with another tag', tags: ['infra'], source: KEPT_SOURCE, kept: false },
  { label: 'tag with a longer name', tags: [`${TAG}-old`], source: KEPT_SOURCE, kept: false },
  { label: 'tag ending a longer name', tags: [`not-${TAG}`], source: KEPT_SOURCE, kept: false },
  { label: 'tag in another case', tags: [TAG.toUpperCase()], source: KEPT_SOURCE, kept: false },
  { label: 'tag after a quote inside another tag', tags: [`x"${TAG}`], source: KEPT_SOURCE, kept: false },
  { label: 'prefix with a capital first letter', tags: [TAG], source: `C${PREFIX.slice(1)}session-one`, kept: false },
  { label: 'prefix in upper case', tags: [TAG], source: `${PREFIX.toUpperCase()}session-one`, kept: false },
  { label: 'prefix not at the start', tags: [TAG], source: `x-${KEPT_SOURCE}`, kept: false },
  { label: 'prefix without its colon', tags: [TAG], source: `${PREFIX.slice(0, -1)}-session-one`, kept: false },
];

interface TableRow { id: string; pinned: boolean; kind: 'distilled' | 'raw'; deletable: boolean }

function seedTable(root: string): TableRow[] {
  const rows: TableRow[] = [];
  for (const c of KEEP_CASES) {
    for (const pinned of [false, true]) {
      for (const kind of ['distilled', 'raw'] as const) {
        const entry = createMemory7(`table row ${rows.length}: ${c.label}`, { tags: c.tags, source: c.source, pinned, kind, ...RAW_FIELDS });
        writeEntry(root, entry);
        rows.push({ id: entry.id, pinned, kind, deletable: !pinned && kind !== 'raw' && !c.kept });
      }
    }
  }
  return rows;
}

function sqlDeletableIds(root: string): string[] {
  const db = openHippoDb(root);
  try {
    // SAFETY: rows' shape matches the single id column named in the SELECT.
    return (db.prepare(`SELECT id FROM memories WHERE ${AUTO_DELETABLE_SQL}`).all() as { id: string }[]).map((r) => r.id).sort();
  } finally {
    closeHippoDb(db);
  }
}

describe('the keep pair', () => {
  it('lists the compaction tag with the compaction source prefix', () => {
    expect(KEEP_PAIRS).toContainEqual({ tag: COMPACTION_MEMORY_TAG, sourcePrefix: COMPACTION_SOURCE_PREFIX });
  });

  it('the compaction tag is a no-merge tag', () => {
    expect(NO_MERGE_TAGS.has(COMPACTION_MEMORY_TAG)).toBe(true);
  });

  it('the SQL matches the prefix by length and never with LIKE, which ignores case', () => {
    expect(AUTO_DELETABLE_SQL).toContain(`substr(source, 1, ${PREFIX.length}) = '${PREFIX}'`);
    expect(AUTO_DELETABLE_SQL).not.toMatch(/LIKE/i);
  });
});

describe('canAutoDelete and AUTO_DELETABLE_SQL agree, over pinned x kind x tags x source', () => {
  it('canAutoDelete gives the table answer for every row', () => {
    const root = newRoot();
    const table = seedTable(root);
    const byId = new Map(loadAllEntries(root).map((e) => [e.id, e]));

    expect(table).toHaveLength(KEEP_CASES.length * 4);
    for (const row of table) expect(canAutoDelete(byId.get(row.id)!), JSON.stringify(byId.get(row.id))).toBe(row.deletable);
  });

  it('the SQL selects exactly the rows canAutoDelete allows', () => {
    const root = newRoot();
    const table = seedTable(root);
    const fromFunction = loadAllEntries(root).filter(canAutoDelete).map((e) => e.id).sort();

    expect(sqlDeletableIds(root)).toEqual(fromFunction);
    expect(sqlDeletableIds(root)).toEqual(table.filter((r) => r.deletable).map((r) => r.id).sort());
    expect(fromFunction.length).toBeGreaterThan(0);
    expect(fromFunction.length).toBeLessThan(table.length);
  });

  it('a tag that holds the quoted keep tag inside its own text is stored so, and still does not count', () => {
    const root = newRoot();
    const tricky = createMemory7('tag with a quote inside it', { tags: [`x"${TAG}`], source: KEPT_SOURCE });
    writeEntry(root, tricky);
    const db = openHippoDb(root);
    try {
      // SAFETY: row's shape matches the single tags_json column named in the SELECT.
      const stored = db.prepare(`SELECT tags_json FROM memories WHERE id = ?`).get(tricky.id) as { tags_json: string };
      expect(stored.tags_json).toContain(`"${TAG}"`);
    } finally {
      closeHippoDb(db);
    }

    expect(sqlDeletableIds(root)).toEqual([tricky.id]);
    expect(canAutoDelete(readEntry(root, tricky.id)!)).toBe(true);
  });

  it('a row whose tags_json is not JSON reads as untagged in both, and does not stop the SQL', () => {
    const root = newRoot();
    const broken = createMemory7('row with unreadable tags', { tags: [TAG], source: KEPT_SOURCE });
    writeEntry(root, broken);
    const db = openHippoDb(root);
    try {
      db.prepare(`UPDATE memories SET tags_json = ? WHERE id = ?`).run('not json', broken.id);
    } finally {
      closeHippoDb(db);
    }

    expect(sqlDeletableIds(root)).toEqual([broken.id]);
    expect(canAutoDelete(readEntry(root, broken.id)!)).toBe(true);
  });
});

describe('the store refuses an automatic removal of a kept row', () => {
  it('deleteEntry with automatic refuses it, and an explicit delete still works', () => {
    const root = newRoot();
    const kept = keptRow('the release train leaves on thursdays');
    const merged = createMemory7('the release train leaves on fridays', { tags: [TAG], source: 'consolidation' });
    writeEntry(root, kept);
    writeEntry(root, merged);

    expect(deleteEntry(root, kept.id, { automatic: true })).toBe(false);
    expect(readEntry(root, kept.id)).not.toBeNull();
    expect(deleteEntry(root, merged.id, { automatic: true })).toBe(true);
    expect(deleteEntry(root, kept.id)).toBe(true);
  });

  it('the batch flush skips a kept row in both its deletes and its dormant moves', () => {
    const root = newRoot();
    const kept = keptRow('the release train leaves on thursdays');
    const plain = createMemory7('the staging cluster restarts on sundays');
    writeEntry(root, kept);
    writeEntry(root, plain);
    const move = { entry: readEntry(root, kept.id)!, strength: 0.01, reason: 'decay' as const, dormantAt: new Date().toISOString() };

    expect(batchWriteAndDelete(root, [], [kept.id, plain.id], { dormant: [move] })).toEqual([plain.id]);
    expect(readEntry(root, kept.id)).not.toBeNull();
    expect(readEntry(root, plain.id)).toBeNull();
  });
});

describe('sleep with decay forced', () => {
  it.each([
    ['dormant on', {}],
    ['dormant off', { dormant: { enabled: false } }],
  ])('%s: the kept row stays active, the merged-source row and the plain row go', async (name, config) => {
    const root = newRoot(JSON.stringify({ replay: { count: 0 }, ...config }));
    const kept = keptRow('the release train leaves on thursdays');
    const merged = createMemory7('the release train leaves on fridays', { tags: [TAG], source: 'consolidation' });
    const plain = createMemory7('the staging cluster restarts on sundays');
    for (const e of [kept, merged, plain]) writeEntry(root, e);

    await consolidate(root, { now: sixtyDaysOn() });

    expect(readEntry(root, kept.id)).not.toBeNull();
    expect(readEntry(root, merged.id)).toBeNull();
    expect(readEntry(root, plain.id)).toBeNull();
    expect(listDormant(ctxFor(root)).map((m) => m.id).sort()).toEqual(name === 'dormant on' ?[merged.id, plain.id].sort() : []);
  });

  it('with the learned memory-value rescue on, the kept row still stays active and never goes dormant', async () => {
    const root = newRoot(JSON.stringify({ replay: { count: 0 }, memoryValue: { enabled: true } }));
    const kept = keptRow('the release train leaves on thursdays');
    writeEntry(root, kept);
    for (let i = 0; i < 12; i++) writeEntry(root, createMemory7(`faded observation number ${i} about module ${i} internals`));

    await consolidate(root, { now: sixtyDaysOn() });

    expect(readEntry(root, kept.id)).not.toBeNull();
    expect(listDormant(ctxFor(root)).map((m) => m.id)).not.toContain(kept.id);
  });

  it('a kept row survives a second sleep further on', async () => {
    const root = newRoot();
    const kept = keptRow('the release train leaves on thursdays');
    writeEntry(root, kept);

    await consolidate(root, { now: sixtyDaysOn() });
    await consolidate(root, { now: new Date(Date.now() + 400 * DAY) });

    expect(readEntry(root, kept.id)).not.toBeNull();
  });
});

describe('dedupe and audit leave a kept row alone', () => {
  it.each([
    ['kept', KEPT_SOURCE, true],
    ['merged-source', 'consolidation', false],
  ])('dedupe removes a weaker duplicate only when it is not kept (%s)', (_label, source, survives) => {
    const root = newRoot();
    const text = 'the build cache lives in /var/cache/hippo on the CI runners';
    const keeper = createMemory7(text);
    const copy = { ...createMemory7(text, { tags: [TAG], source }), strength: 0.5 };
    writeEntry(root, keeper);
    writeEntry(root, copy);

    deduplicateStore(root);

    expect(readEntry(root, keeper.id)).not.toBeNull();
    expect(readEntry(root, copy.id) !== null).toBe(survives);
  });

  it('the quality audit only warns about a short kept row, and sleep keeps it', async () => {
    const root = newRoot();
    const kept = keptRow('nope');
    const merged = createMemory7('nope', { tags: [TAG], source: 'consolidation' });
    writeEntry(root, kept);

    expect(auditMemory(kept)).toMatchObject({ severity: 'warning', reason: expect.stringContaining('keep rule') });
    expect(auditMemory(merged)?.severity).toBe('error');

    const result = await sleep(ctxFor(root), { noShare: true });

    expect(readEntry(root, kept.id)).not.toBeNull();
    expect(result.audit?.errorsRemoved ?? 0).toBe(0);
  });
});

describe('forget and supersede still work on a kept row', () => {
  it('forget removes it', () => {
    const root = newRoot();
    const kept = keptRow('the release train leaves on thursdays');
    writeEntry(root, kept);

    expect(forget(ctxFor(root), kept.id)).toEqual({ ok: true, id: kept.id });
    expect(readEntry(root, kept.id)).toBeNull();
  });

  it('supersede chains it to a new row', () => {
    const root = newRoot();
    const kept = keptRow('the release train leaves on thursdays');
    writeEntry(root, kept);

    const result = supersede(ctxFor(root), kept.id, 'the release train leaves on tuesdays now');

    expect(readEntry(root, kept.id)?.superseded_by).toBe(result.newId);
    expect(readEntry(root, result.newId)?.content).toBe('the release train leaves on tuesdays now');
  });
});

describe('kept rows are not merged and not sent to extraction', () => {
  const BASE = 'Fixed the server crash due to memory overflow in the worker process `pool.ts`';
  const seedThree = (root: string, make: (content: string) => MemoryEntry) => {
    for (const content of [BASE, `${BASE} again today`, `${BASE} once more`]) writeEntry(root, make(content));
  };

  it('control: with a key set, three untagged look-alike rows reach the fetcher and merge', async () => {
    const root = newRoot();
    seedThree(root, (content) => createMemory7(content));
    vi.stubEnv('ANTHROPIC_API_KEY', FAKE_KEY);
    const fetcher = okFetcher();

    const result = await consolidate(root, { now: new Date(), fetcher });

    expect(fetcher).toHaveBeenCalled();
    expect(result.extractionCandidates).toBe(3);
    expect(result.merged).toBeGreaterThan(0);
  });

  it('three kept look-alike rows never reach the fetcher and are not merged', async () => {
    const root = newRoot();
    seedThree(root, keptRow);
    vi.stubEnv('ANTHROPIC_API_KEY', FAKE_KEY);
    const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('a kept row reached the LLM'); });

    const result = await consolidate(root, { now: new Date(), fetcher });

    expect(fetcher).not.toHaveBeenCalled();
    expect(result.extractionCandidates).toBe(0);
    expect(result.merged).toBe(0);
    expect(loadAllEntries(root)).toHaveLength(3);
  });

  it('conflict detection still sees a kept row', async () => {
    const root = newRoot();
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    writeEntry(root, createMemory7('The feature flag is enabled for production users', { tags: [TAG, 'feature-flag', 'prod'], source: KEPT_SOURCE }));
    writeEntry(root, createMemory7('The feature flag is disabled for production users', { tags: ['feature-flag', 'prod'] }));

    await consolidate(root, { now: new Date() });

    expect(listMemoryConflicts(root)).toHaveLength(1);
  });
});
