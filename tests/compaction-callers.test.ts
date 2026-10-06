// The seams a server uses to save another machine's compaction and failures: its project, actor, tenant and request id, never the server's own.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadContentsWithTag } from '../src/store/entry-reads.js';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../src/db.js';
import { tableHasColumn } from '../src/db/tables.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { _resetSharedStoreCacheForTests } from '../src/config.js';
import { clearProjectIdentityCache } from '../src/project-identity.js';
import { markSnapshotSaved, recordSnapshotSaved, recordSummary, saveItems, startCompaction, type ItemContext } from '../src/compaction-record.js';
import { storeLesson } from '../src/capture-error.js';

const TENANT = 'acme-tenant';
const META = { sessionId: 's1', trigger: 'auto', cwd: null, transcriptPath: null };
const CALLER = { actor: 'alice@acme', origins: ['acme/app', 'app'] } as const;
const noLog = (): void => {};

let dir: string;
let root: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-compaction-callers-'));
  for (const name of ['HOME', 'USERPROFILE', 'HIPPO_HOME']) vi.stubEnv(name, dir);
  clearProjectIdentityCache();
  _resetSharedStoreCacheForTests();
  root = path.join(dir, 'server', '.hippo');
  fs.mkdirSync(root, { recursive: true });
  initStore(root);
  // A server's store: its own folder names no project, so nothing here may fall back to it.
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ sharedStore: true }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  _resetSharedStoreCacheForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

function withDb<T>(fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

/** The v54 column, which the keying migration adds; guarded so the test still runs once it lands. */
function addRequestIdColumn(db: DatabaseSyncLike): void {
  if (!tableHasColumn(db, 'compactions', 'request_id')) db.exec(`ALTER TABLE compactions ADD COLUMN request_id TEXT`);
}

interface RecordRow { origin_project: string; status: string; snapshot_saved: number }

function recordRow(db: DatabaseSyncLike, id: string): RecordRow | undefined {
  return db.prepare(`SELECT origin_project, status, snapshot_saved FROM compactions WHERE id = ?`).get<RecordRow | undefined>(id);
}

function requestIdOf(db: DatabaseSyncLike, id: string): string | null | undefined {
  return db.prepare(`SELECT request_id FROM compactions WHERE id = ?`).get<{ request_id: string | null } | undefined>(id)?.request_id;
}

function seed(content: string, origin: string, tags: string[] = []): void {
  writeEntry(root, { ...createMemory(content, { tenantId: TENANT, tags, baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), origin_project: origin });
}

interface WrittenRow { content: string; origin_project: string | null; actor: string }

function writtenRows(db: DatabaseSyncLike, source: string): WrittenRow[] {
  // SAFETY: the SELECT names exactly WrittenRow's three columns.
  return db.prepare(
    `SELECT m.content, m.origin_project, a.actor FROM memories m JOIN audit_log a ON a.target_id = m.id AND a.op = 'remember'
     WHERE m.tenant_id = ? AND m.source = ? ORDER BY m.content`,
  ).all(TENANT, source) as WrittenRow[];
}

describe('recordSummary for a caller', () => {
  it("inserts the caller's project and request id when no started record exists", () => {
    withDb((db) => {
      addRequestIdColumn(db);
      const rec = recordSummary(db, root, TENANT, META, { summary: '', items: [] }, new Date(), { originProject: 'acme/app', requestId: 'req-1' });
      expect(rec.originProject).toBe('acme/app');
      expect(recordRow(db, rec.id)).toMatchObject({ origin_project: 'acme/app', status: 'summarised' });
      expect(requestIdOf(db, rec.id)).toBe('req-1');
    });
  });

  it('stamps the request id on the started record it summarises', () => {
    withDb((db) => {
      addRequestIdColumn(db);
      const id = startCompaction(db, TENANT, { ...META, originProject: 'acme/app' });
      const rec = recordSummary(db, root, TENANT, META, { summary: '', items: ['x'] }, new Date(), { originProject: 'acme/app', requestId: 'req-2' });
      expect(rec.id).toBe(id);
      expect(recordRow(db, id)?.status).toBe('summarised');
      expect(requestIdOf(db, id)).toBe('req-2');
    });
  });

  it("takes the caller's project with no request id, on a store that may predate the column", () => {
    withDb((db) => {
      const rec = recordSummary(db, root, TENANT, META, { summary: '', items: [] }, new Date(), { originProject: 'acme/app' });
      expect(rec.originProject).toBe('acme/app');
    });
  });
});

describe('saveItems for a caller', () => {
  const ITEMS = [
    'The release script must run from the repo root because it reads the env file by a relative path.',
    'Integration tests need the local Postgres container started before the suite or every case times out.',
  ];

  it("writes under the caller's project and actor, holding back only the caller's own restatements", () => {
    seed(ITEMS[0], 'app');
    seed(ITEMS[1], 'other/project');
    withDb((db) => {
      const rec = recordSummary(db, root, TENANT, META, { summary: '', items: ITEMS }, new Date(), { originProject: 'acme/app' });
      const ctx: ItemContext = { tenantId: TENANT, recordId: rec.id, sessionId: 's1', originProject: 'acme/app', cwd: null, items: ITEMS, caller: CALLER };
      expect(saveItems(db, root, ctx, noLog)).toBe(1);
      expect(writtenRows(db, 'compaction:s1')).toEqual([{ content: ITEMS[1], origin_project: 'acme/app', actor: 'alice@acme' }]);
      expect(recordRow(db, rec.id)?.status).toBe('done');
    });
  });

  it('keeps the post-compact actor and folder fallback when no caller is set', () => {
    withDb((db) => {
      const ctx: ItemContext = { tenantId: TENANT, recordId: null, sessionId: 's2', originProject: 'acme/app', cwd: null, items: [ITEMS[1]] };
      expect(saveItems(db, root, ctx, noLog)).toBe(1);
      expect(writtenRows(db, 'compaction:s2')).toEqual([{ content: ITEMS[1], origin_project: null, actor: 'post-compact' }]);
    });
  });
});

describe('storeLesson for a caller', () => {
  const LESSON = 'Bash: npm run build failed: src/a.ts(12,3): error TS2304: Cannot find name foo';
  const other = { actor: 'bob@acme', originProject: 'acme/web', origins: ['acme/web'] };

  it('checks repeats within the caller project and stamps its origin and actor', () => {
    expect(storeLesson(root, TENANT, LESSON, { ...CALLER, originProject: 'acme/app' })).toBe('stored');
    expect(storeLesson(root, TENANT, LESSON, { ...CALLER, originProject: 'acme/app' })).toBe('duplicate');
    expect(storeLesson(root, TENANT, LESSON, other)).toBe('stored');
    withDb((db) => {
      expect(writtenRows(db, 'tool-failure').map((r) => [r.origin_project, r.actor]).sort()).toEqual([['acme/app', 'alice@acme'], ['acme/web', 'bob@acme']]);
    });
  });

  it('counts a user-global lesson as a repeat in every project', () => {
    seed(LESSON, '', ['error', 'auto-captured']);
    expect(loadContentsWithTag(root, TENANT, 'auto-captured', ['acme/web'])).toEqual([LESSON]);
    expect(storeLesson(root, TENANT, LESSON, other)).toBe('duplicate');
  });
});

describe('snapshot_saved under a tenant the environment does not name', () => {
  it('marks the record through both the handle and the root', () => {
    withDb((db) => {
      const a = startCompaction(db, TENANT, { ...META, originProject: 'acme/app' });
      const b = startCompaction(db, TENANT, { ...META, sessionId: 's3', originProject: 'acme/app' });
      markSnapshotSaved(db, TENANT, a);
      recordSnapshotSaved(root, TENANT, b, (m) => { throw new Error(m); });
      expect([recordRow(db, a)?.snapshot_saved, recordRow(db, b)?.snapshot_saved]).toEqual([1, 1]);
    });
  });
});
