// The entry filter's WHERE terms (sqlite/entries/entry-filter.ts) keep the rows each field means, in order, over memories and
// dormant snapshots alike.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import type { MemoryEntry } from '../../src/base/memory/entry.js';
import { readAll } from '../../src/base/util/pages.js';
import { ALL_TENANTS } from '../../src/base/util/tenant.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import type { EntryFilter } from '../../src/base/ports/store/reports.js';
import type { EntryCursor, EntryPage } from '../../src/base/ports/store/types.js';
import { dormantSnapshotsWhere, insertDormantRow } from '../../src/store/sqlite/dormant/dormant-rows.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { writeEntriesTogether } from '../_helpers/root-forms.js';
import {
  runOnFixture,
  seedTwoTenants,
  TENANT_A,
  TENANT_B,
  type GroupCall,
  type TwoTenantFixture,
} from '../_helpers/store-conformance.js';

const at = (minute: number): string => new Date(Date.UTC(2026, 2, 1, 0, minute)).toISOString();

function row(id: string, minute: number, over: Partial<MemoryEntry> = {}): MemoryEntry {
  return { ...createMemory(`note ${id}`, { tenantId: TENANT_A }), id: `mem_${id}`, created: at(minute), ...over };
}

const IMPORTED = 'agent-memory:claude:p/';
const DIGEST = { source: 'session-digest', tags: ['session-digest'] };

// Each field's edges: the byte after a prefix, case and wildcard refs, superseded and kind spreads, ties on created.
const ROWS: readonly MemoryEntry[] = [
  row('f01', 1, { source: 'cli', tags: ['deploy'] }),
  row('f02', 2, { source: `${IMPORTED}a.md#h`, originProject: 'alpha', tags: ['claude-code-memory'] }),
  row('f03', 3, { source: `${IMPORTED}b.md#h`, originProject: 'beta', supersededBy: 'mem_f01' }),
  row('f04', 4, { source: 'agent-memorz', originProject: 'alpha' }),
  row('f05', 5, { ...DIGEST, sourceSessionId: 's1' }),
  row('f06', 6, { source: 'session-digest', tags: ['other'], sourceSessionId: 's2' }),
  row('f07', 7, { source: 'cli', tags: ['session-digest'] }),
  row('f08', 8, { kind: 'raw', artifactRef: 'vault:notes:a.md', sourceSessionId: 's1', originProject: 'alpha' }),
  row('f09', 9, { kind: 'raw', artifactRef: 'vault:Notes:b.md', sourceSessionId: 's1' }),
  row('f10', 10, { kind: 'raw', artifactRef: 'vault:notesX:c.md', sourceSessionId: 's2' }),
  row('f11', 11, { kind: 'raw', sourceSessionId: 's1', originProject: 'beta' }),
  row('f12', 12, { kind: 'raw', sourceSessionId: 's1', supersededBy: 'mem_f11' }),
  row('f13', 13, { kind: 'superseded', originProject: 'alpha' }),
  row('f14', 14, { kind: 'archived', originProject: 'alpha' }),
  row('f15b', 15, { source: 'consolidation' }),
  row('f15a', 15, { source: 'consolidation', originProject: 'alpha' }),
  row('f16', 16, { source: `${IMPORTED}日本.md` }),
  row('f17', 17, { source: 'cli' }),
  row('f18', 18, { source: 'cli' }),
  row('g01', 2, { ...DIGEST, tenantId: TENANT_B, kind: 'raw', sourceSessionId: 's1', originProject: 'alpha' }),
  row('g02', 3, { source: `${IMPORTED}a.md#h`, tenantId: TENANT_B }),
];

const DORMANT: readonly MemoryEntry[] = [
  row('d01', 20, { source: `${IMPORTED}gone.md#h`, originProject: 'alpha', tags: ['x'] }),
  row('d02', 21, { source: 'cli', sourceSessionId: 's1' }),
  row('d03', 22, { source: `${IMPORTED}gone.md#h`, originProject: 'alpha', tenantId: TENANT_B }),
  row('d04', 23, { source: `${IMPORTED}old.md#h`, originProject: 'beta', kind: 'raw', supersededBy: 'mem_f01' }),
];

/** The rows, then those the writer cannot make: tags that are a JSON string or not JSON, an empty superseded_by. */
function oddColumns(dir: string): void {
  writeEntriesTogether(dir, ROWS);
  const db = openHippoDb(dir);
  try {
    db.prepare(`UPDATE memories SET tags_json = '"claude-code-memory"' WHERE id = 'mem_f16'`).run();
    db.prepare(`UPDATE memories SET tags_json = 'not json' WHERE id = 'mem_f17'`).run();
    db.prepare(`UPDATE memories SET superseded_by = '' WHERE id = 'mem_f18'`).run();
    for (const entry of DORMANT) {
      insertDormantRow(db, { entry, strength: 0.01, reason: 'source-deleted', dormantAt: at(30) });
    }
  } finally {
    closeHippoDb(db);
  }
}

const FILTERS = {
  'one tenant': { tenantId: TENANT_A },
  'every tenant': { tenantId: ALL_TENANTS },
  ids: { tenantId: TENANT_A, ids: ['mem_f02', 'mem_f12', 'mem_g01', 'mem_missing'] },
  'one id': { tenantId: TENANT_A, ids: ['mem_f05'] },
  'ids of every tenant': { tenantId: ALL_TENANTS, ids: ['mem_f02', 'mem_g01'] },
  'one origin': { tenantId: TENANT_A, origins: ['alpha'] },
  'user-global and an origin': { tenantId: TENANT_A, origins: ['', 'alpha'] },
  'no such origin': { tenantId: TENANT_A, origins: ['gamma'] },
  source: { tenantId: TENANT_A, source: 'session-digest' },
  prefix: { tenantId: TENANT_A, sourcePrefix: 'agent-memory:' },
  'prefix of every tenant': { tenantId: ALL_TENANTS, sourcePrefix: 'agent-memory:' },
  'prefix in an origin': { tenantId: TENANT_A, sourcePrefix: 'agent-memory:', origins: ['alpha'] },
  'empty prefix': { tenantId: TENANT_A, sourcePrefix: '' },
  'ref prefix': { tenantId: TENANT_A, artifactRefPrefix: 'vault:notes:' },
  'ref prefix with a wildcard': { tenantId: TENANT_A, artifactRefPrefix: 'vault:no_es:' },
  tag: { tenantId: TENANT_A, tag: 'session-digest' },
  'tag a JSON string holds': { tenantId: TENANT_A, tag: 'claude-code-memory' },
  'one kind': { tenantId: TENANT_A, kinds: ['raw'] },
  'two kinds': { tenantId: TENANT_A, kinds: ['distilled', 'superseded'] },
  live: { tenantId: TENANT_A, live: true },
  session: { tenantId: TENANT_A, sessionId: 's1' },
  'assemble raws': { tenantId: TENANT_A, kinds: ['raw'], live: true, sessionId: 's1', origins: ['', 'alpha'] },
  digests: { tenantId: TENANT_A, source: 'session-digest', tag: 'session-digest', live: true },
  'vault raws': { tenantId: TENANT_A, kinds: ['raw'], artifactRefPrefix: 'vault:notes:' },
  'churn rows': { tenantId: TENANT_A, origins: ['alpha'], live: true, kinds: ['distilled', 'superseded'] },
  'merge rows': { tenantId: TENANT_A, origins: [''], live: true, sourcePrefix: 'consolidation' },
  'imported rows': { tenantId: TENANT_A, sourcePrefix: 'agent-memory:', live: true },
} satisfies Readonly<Record<string, EntryFilter>>;

const EMPTY = new Set(['no such origin', 'ref prefix with a wildcard']);

type Walk = GroupCall<'base', EntryPage | MemoryEntry[]>;

const walk =
  (filter: EntryFilter, newest: boolean): Walk =>
  (g) =>
    readAll((after?: EntryCursor) => g.entriesWhere(filter, { limit: 2, after, newest }));

describe('entriesWhere', () => {
  let fixture: TwoTenantFixture;
  let kept: Map<string, string[]>;

  beforeAll(async () => {
    fixture = seedTwoTenants();
    oddColumns(fixture.dir);
    const named = Object.entries(FILTERS).flatMap(([name, filter]): [string, Walk][] => [
      [`${name} oldest`, walk(filter, false)],
      [`${name} newest`, walk(filter, true)],
      [`${name} first page`, (g) => g.entriesWhere(filter, { limit: 3 })],
    ]);
    const sqlite = await runOnFixture(
      fixture,
      'base',
      named.map(([, call]) => call),
    );
    kept = new Map(
      named.map(([name], i) => {
        const outcome = sqlite.outcomes[i];
        if (outcome === undefined || !('value' in outcome)) throw new Error(`${name} did not resolve`);
        const rows = Array.isArray(outcome.value) ? outcome.value : outcome.value.entries;
        return [name, rows.map((e) => e.id)];
      }),
    );
  });

  afterAll(() => rmSync(fixture.dir, { recursive: true, force: true }));

  it.each(Object.keys(FILTERS))('%s keeps rows, and newest first is oldest first reversed', (name) => {
    const oldest = kept.get(`${name} oldest`) ?? [];
    expect(oldest.length > 0).toBe(!EMPTY.has(name));
    expect(kept.get(`${name} newest`)).toEqual([...oldest].reverse());
    expect(kept.get(`${name} first page`)).toEqual(oldest.slice(0, 3));
  });

  it('reads each edge as the field means it', () => {
    const ids = (name: string): string[] => (kept.get(`${name} oldest`) ?? []).map((id) => id.slice(4));
    expect(ids('ref prefix')).toEqual(['f08']);
    expect(ids('tag a JSON string holds')).toEqual(['f02']);
    expect(ids('prefix')).toEqual(['f02', 'f03', 'f16']);
    expect(ids('live')).toContain('f18');
    expect(ids('live')).not.toContain('f12');
    expect(ids('ids')).toEqual(['f02', 'f12']);
    expect(ids('empty prefix')).toEqual(ids('one tenant'));
    expect(ids('merge rows')).toEqual(['f15b']);
    expect(ids('assemble raws')).toEqual(['f08', 'f09']);
  });
});

describe('dormant snapshots under the same filter', () => {
  let fixture: TwoTenantFixture;

  beforeAll(() => {
    fixture = seedTwoTenants();
    oddColumns(fixture.dir);
  });

  afterAll(() => rmSync(fixture.dir, { recursive: true, force: true }));

  it('keeps, for each filter, the snapshots whose fields it names', () => {
    const db = openHippoDb(fixture.dir);
    try {
      const every = dormantSnapshotsWhere(db, { tenantId: ALL_TENANTS });
      expect(every.map((snap) => snap.entry.id)).toEqual(['mem_d01', 'mem_d02', 'mem_d04', 'mem_d03']);
      const kept = (name: keyof typeof FILTERS): string[] =>
        dormantSnapshotsWhere(db, FILTERS[name]).map((snap) => snap.entry.id);
      expect(kept('one tenant')).toEqual(['mem_d01', 'mem_d02', 'mem_d04']);
      expect(kept('one origin')).toEqual(['mem_d01']);
      expect(kept('prefix')).toEqual(['mem_d01', 'mem_d04']);
      expect(kept('prefix of every tenant')).toEqual(['mem_d01', 'mem_d04', 'mem_d03']);
      expect(kept('prefix in an origin')).toEqual(['mem_d01']);
      expect(kept('one kind')).toEqual(['mem_d04']);
      expect(kept('live')).toEqual(['mem_d01', 'mem_d02']);
      expect(kept('session')).toEqual(['mem_d02']);
      expect(kept('no such origin')).toEqual([]);
    } finally {
      closeHippoDb(db);
    }
  });
});
