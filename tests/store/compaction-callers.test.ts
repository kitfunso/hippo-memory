// The seams a server uses to save another machine's compaction and failures: its project, actor, tenant and request id, never the server's own.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initStore, handlesOf } from '../../src/store/open.js';
import { writeEntry } from '../../src/store/entry-writes.js';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { closeHippoDb, openHippoDb, runWithRequestStores, type DatabaseSyncLike } from '../../src/db/index.js';
import { isStoreBusy } from '../../src/store/busy.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/core/memory.js';
import { _resetSharedStoreCacheForTests } from '../../src/core/config.js';
import { _resetProjectIdentityCacheForTests } from '../../src/core/project-identity.js';
import { PRE_COMPACT_INSTRUCTION } from '../../src/capture/compaction-record.js';
import { markSnapshotSaved, recordSnapshotSaved, recordSummary, saveItems, startCompaction, type ItemContext } from '../../src/store/compactions-record.js';
import { captureToolFailure, storeLesson } from '../../src/capture/capture-error.js';
import { failureTarget } from '../_helpers/failure-target.js';
import { failureHash, failureReport } from '../../src/capture/failure-reading.js';
import { WORKING_STATE_CAPS } from '../../src/capture/working-state.js';
import { COMPACTION_ITEM_MAX_CHARS } from '../../src/util/compaction-items.js';
import { compactResumeText } from '../../src/api/context-render.js';
import { saveActiveTaskSnapshot } from '../../src/store/sessions.js';
import { BadRequestError, ConflictError } from '../../src/core/api-errors.js';
import type { Context } from '../../src/api/types.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import type { StoreReach } from '../../src/store/port.js';

// A server ctx carries a reach from its composition root; the ledger books nowhere without one.
const SHARED_REACH: StoreReach = { hasLocal: true, isGlobal: false, shared: true };
import {
  bindSessionOwner,
  captureFailureForCaller,
  compactResumeForCaller,
  preCompactForCaller,
  saveCompactionItemsForCaller,
  sessionEndHandoffForCaller,
  type CallerFailureRequest,
} from '../../src/server.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadActiveTaskSnapshot } from '../_helpers/root-forms.js';
import type { ContinuityKey } from '../../src/store/port/types.js';

const TENANT = 'acme-tenant';
const META = { sessionId: 's1', trigger: 'auto', cwd: null, transcriptPath: null };
const noLog = (): void => {};
const PROJECT = { name: 'acme/app', legacyName: 'app' } as const;
const ALICE: ContinuityKey = { owner: 'alice', project: ['acme/app', 'app'] };
const BOB: ContinuityKey = { owner: 'bob', project: ['acme/app', 'app'] };
const STATE = { task: 'Ship the caller calls', summary: 'Wrote the tests first.', next_step: 'Implement pre-compact' };
const ITEMS = [
  'The release script must run from the repo root because it reads the env file by a relative path.',
  'Integration tests need the local Postgres container started before the suite or every case times out.',
];
const LESSON = 'Bash: npm run build failed: src/a.ts(12,3): error TS2304: Cannot find name foo';

let dir: string;
let root: string;

beforeEach(() => {
  dir = makeRoot('compaction-callers', { init: false });
  for (const name of ['HOME', 'USERPROFILE', 'HIPPO_HOME']) vi.stubEnv(name, dir);
  _resetProjectIdentityCacheForTests();
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
});

function withDb<T>(fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

interface RecordRow { origin_project: string; status: string; snapshot_saved: number }

function recordRow(db: DatabaseSyncLike, id: string): RecordRow | undefined {
  return db.prepare(`SELECT origin_project, status, snapshot_saved FROM compactions WHERE id = ?`).get<RecordRow | undefined>(id);
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

function owned(owner: string): Context {
  return { hippoRoot: root, store: sqliteStore(root), tenantId: TENANT, actor: { subject: `api_key:hk_${owner}`, role: 'member', owner }, reach: SHARED_REACH };
}

/** Every session lands in the holdout arm at 10000 basis points. */
function holdout(): void {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ sharedStore: true, pilot: { holdoutRateBp: 10000 } }));
}

/** A statement on `table` that fails, so a step's error path runs on the real store; returns the undo. */
function failOn(table: string, when: 'INSERT' | 'UPDATE', message: string): () => void {
  const name = `fail_${table}_${when.toLowerCase()}`;
  withDb((db) => db.exec(`CREATE TRIGGER ${name} BEFORE ${when} ON ${table} BEGIN SELECT RAISE(ABORT, '${message}'); END`));
  return () => withDb((db) => db.exec(`DROP TRIGGER ${name}`));
}

/** Runs `fn` while another connection holds the write lock, with a 50 ms wait so busy shows fast. */
async function whileLocked<T>(fn: () => T): Promise<T> {
  const holder = openHippoDb(root);
  holder.exec('BEGIN IMMEDIATE');
  try {
    return await runWithRequestStores(fn, { busyWaitMs: 50 });
  } finally {
    holder.exec('ROLLBACK');
    closeHippoDb(holder);
  }
}

function count(db: DatabaseSyncLike, table: string, where = '1', ...params: string[]): number {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get<{ n: number }>(...params).n;
}

const WRITTEN_TABLES = ['compactions', 'task_snapshots', 'session_handoffs', 'failure_log', 'memories'] as const;

function rowCounts(): Record<string, number> {
  return withDb((db) => Object.fromEntries(WRITTEN_TABLES.map((t) => [t, count(db, t)])));
}

interface SnapshotRow { id: number; status: string; owner_subject: string | null; origin_project: string | null }

function snapshotRow(db: DatabaseSyncLike, id: number): SnapshotRow | undefined {
  return db.prepare(`SELECT id, status, owner_subject, origin_project FROM task_snapshots WHERE id = ?`).get<SnapshotRow | undefined>(id);
}

interface FailureRow { outcome: string; owner_subject: string | null; origin_project: string | null; request_id: string | null; sig_hash: string | null; detail_hash: string | null }

function failureRows(db: DatabaseSyncLike): FailureRow[] {
  // SAFETY: the SELECT names exactly FailureRow's six columns.
  return db.prepare(`SELECT outcome, owner_subject, origin_project, request_id, sig_hash, detail_hash FROM failure_log ORDER BY id`).all() as FailureRow[];
}

interface HandoffRow { session_id: string; task_id: string | null; owner_subject: string | null; origin_project: string | null }

function handoffRows(db: DatabaseSyncLike): HandoffRow[] {
  // SAFETY: the SELECT names exactly HandoffRow's four columns.
  return db.prepare(`SELECT session_id, task_id, owner_subject, origin_project FROM session_handoffs ORDER BY id`).all() as HandoffRow[];
}

function failure(over: Partial<CallerFailureRequest> = {}): CallerFailureRequest {
  return { sessionId: 'sA', project: PROJECT, tool: 'Bash', text: LESSON, skip: null, rule: null, detailHash: null, requestId: 'fail-1', ...over };
}

const preCompact = (ctx: Context, workingState: typeof STATE | null = STATE) =>
  preCompactForCaller(ctx, { sessionId: 'sA', project: PROJECT, trigger: 'auto', workingState });
const postCompact = (ctx: Context, requestId = 'cmp-1') =>
  saveCompactionItemsForCaller(ctx, { sessionId: 'sA', project: PROJECT, trigger: 'auto', items: ITEMS, requestId });
const sessionEnd = (ctx: Context) =>
  sessionEndHandoffForCaller(ctx, { sessionId: 'sA', project: PROJECT, workingState: null, evidence: { gitRef: 'a'.repeat(40), dirtyTree: false, testStatus: 'unknown' } });

async function caught(fn: () => object): Promise<Error | null> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof Error) return err;
    throw err;
  }
  return null;
}

describe('recordSummary for a caller', () => {
  it("takes the caller's project with no request id, on a store that may predate the column", () => {
    withDb((db) => {
      const rec = recordSummary(db, root, TENANT, { meta: META, text: { summary: '', items: [] }, at: new Date(), caller: { originProject: 'acme/app' } });
      expect(rec.originProject).toBe('acme/app');
    });
  });
});

describe('saveItems for a caller', () => {
  it('keeps the post-compact actor and folder fallback when no caller is set', () => {
    withDb((db) => {
      const ctx: ItemContext = { tenantId: TENANT, recordId: null, sessionId: 's2', originProject: 'acme/app', cwd: null, items: [ITEMS[1]] };
      expect(saveItems(db, root, ctx, noLog, DEFAULT_HALF_LIFE_DAYS)).toBe(1);
      expect(writtenRows(db, 'compaction:s2')).toEqual([{ content: ITEMS[1], origin_project: null, actor: 'post-compact' }]);
    });
  });
});

describe('storeLesson for a caller', () => {
  const other = { actor: 'bob@acme', originProject: 'acme/web', origins: ['acme/web'] };

  it('counts a user-global lesson as a repeat in every project', async () => {
    seed(LESSON, '', ['error', 'auto-captured']);
    expect(sqliteSyncStore(root).lessonWrites.contentsWithTag(TENANT, 'auto-captured', ['acme/web'])).toEqual([LESSON]);
    expect(await storeLesson(failureTarget(root, TENANT), LESSON, other)).toBe('duplicate');
  });
});

describe('snapshot_saved under a tenant the environment does not name', () => {
  it('marks the record through both the handle and the root', () => {
    withDb((db) => {
      const a = startCompaction(db, TENANT, { ...META, originProject: 'acme/app' });
      const b = startCompaction(db, TENANT, { ...META, sessionId: 's3', originProject: 'acme/app' });
      markSnapshotSaved(db, TENANT, a);
      recordSnapshotSaved(handlesOf(root).on, TENANT, b, (m) => { throw new Error(m); });
      expect([recordRow(db, a)?.snapshot_saved, recordRow(db, b)?.snapshot_saved]).toEqual([1, 1]);
    });
  });
});

describe('preCompactForCaller', () => {
  it("saves the owner's snapshot and returns the instruction", async () => {
    const bobs = saveActiveTaskSnapshot(root, TENANT, { task: 'Bob task', summary: 'b', next_step: 'b', session_id: 'sB' }, BOB);
    expect(await preCompact(owned('alice'))).toEqual({ stdout: PRE_COMPACT_INSTRUCTION });
    const mine = loadActiveTaskSnapshot(root, TENANT, ALICE);
    expect(mine).toMatchObject({ ...STATE, source: 'pre-compact', session_id: 'sA' });
    withDb((db) => expect(snapshotRow(db, mine?.id ?? 0)).toMatchObject({ owner_subject: 'alice', origin_project: 'acme/app' }));
    // The save superseded only Alice's rows: Bob's own row is still his active one.
    expect(loadActiveTaskSnapshot(root, TENANT, BOB)?.id).toBe(bobs.id);
  });

  it("keeps the owner's earlier field for the same session when a sent field is empty", async () => {
    saveActiveTaskSnapshot(root, TENANT, { task: 'Earlier task', summary: 'old', next_step: 'Earlier step', session_id: 'sA' }, ALICE);
    await preCompact(owned('alice'), { task: '', summary: 'New summary', next_step: '' });
    expect(loadActiveTaskSnapshot(root, TENANT, ALICE)).toMatchObject({ task: 'Earlier task', summary: 'New summary', next_step: 'Earlier step' });
  });

  it("holdout gives '' and writes no snapshot", async () => {
    holdout();
    expect(await preCompact(owned('alice'))).toEqual({ stdout: '' });
    expect(rowCounts()).toMatchObject({ compactions: 0, task_snapshots: 0 });
  });

  it('an over-cap field names the field', async () => {
    const summary = 'x'.repeat(WORKING_STATE_CAPS.summary + 1);
    const err = await caught(() => preCompact(owned('alice'), { ...STATE, summary }));
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err).toMatchObject({ status: 400, message: `working state summary: at most ${WORKING_STATE_CAPS.summary} characters` });
    expect(await preCompact(owned('alice'), { ...STATE, summary: summary.slice(1) })).toEqual({ stdout: PRE_COMPACT_INSTRUCTION });
  });

  it('cuts each field back to its cap after the scrub, the summary keeping its newest turns', async () => {
    // a@b.co masks to [email], one longer, so a field sent at its cap runs one over after the scrub.
    const atCap = (cap: number, tail: string): string => `Mail a@b.co first. ${'Then run the build. '.repeat(120)}`.slice(0, cap - tail.length) + tail;
    await preCompact(owned('alice'), { task: atCap(WORKING_STATE_CAPS.task, 'T'), summary: atCap(WORKING_STATE_CAPS.summary, 'NEWEST'), next_step: atCap(WORKING_STATE_CAPS.next_step, 'N') });
    const saved = loadActiveTaskSnapshot(root, TENANT, ALICE);
    expect(saved?.task).toHaveLength(WORKING_STATE_CAPS.task);
    expect(saved?.task.startsWith('Mail [email] first.')).toBe(true);
    expect(saved?.next_step).toHaveLength(WORKING_STATE_CAPS.next_step);
    expect(saved?.summary.length).toBeLessThanOrEqual(WORKING_STATE_CAPS.summary);
    expect(saved?.summary.endsWith('NEWEST')).toBe(true);
  });

  it('a snapshot failure still returns the instruction', async () => {
    failOn('task_snapshots', 'INSERT', 'snapshot boom');
    expect(await preCompact(owned('alice'))).toEqual({ stdout: PRE_COMPACT_INSTRUCTION });
    withDb((db) => {
      expect(count(db, 'task_snapshots')).toBe(0);
      expect(count(db, 'compactions', 'tenant_id = ? AND snapshot_saved = 0', TENANT)).toBe(1);
    });
  });

  it('a busy store at startCompaction still returns the instruction (F8)', async () => {
    bindSessionOwner(owned('alice'), 'sA');
    expect(await whileLocked(() => preCompact(owned('alice')))).toEqual({ stdout: PRE_COMPACT_INSTRUCTION });
    expect(rowCounts()).toMatchObject({ compactions: 0, task_snapshots: 0 });
  });

  it('snapshot_saved = 1 on the ctx.tenantId record, whatever the environment names (F9)', async () => {
    vi.stubEnv('HIPPO_TENANT', 'env-tenant');
    await preCompact(owned('alice'));
    withDb((db) => {
      expect(count(db, 'compactions', `tenant_id = ? AND snapshot_saved = 1 AND origin_project = 'acme/app' AND cwd IS NULL`, TENANT)).toBe(1);
      expect(count(db, 'compactions', 'tenant_id = ?', 'env-tenant')).toBe(0);
    });
  });
});

describe('compactResumeForCaller', () => {
  const resume = (ctx: Context, source = 'compact') => compactResumeForCaller(ctx, { sessionId: 'sA', project: PROJECT, source });

  it("source not compact gives ''", async () => {
    saveActiveTaskSnapshot(root, TENANT, { ...STATE, session_id: 'sA' }, ALICE);
    expect(await resume(owned('alice'), 'startup')).toEqual({ stdout: '' });
    expect((await resume(owned('alice'))).stdout).toContain(STATE.task);
  });

  it("holdout gives ''", async () => {
    saveActiveTaskSnapshot(root, TENANT, { ...STATE, session_id: 'sA' }, ALICE);
    holdout();
    expect(await resume(owned('alice'))).toEqual({ stdout: '' });
  });

  it("another session's snapshot gives ''", async () => {
    saveActiveTaskSnapshot(root, TENANT, { ...STATE, session_id: 'sOld' }, ALICE);
    expect(await resume(owned('alice'))).toEqual({ stdout: '' });
  });

  it("renders the owner's snapshot and books one compact_resume row", async () => {
    const mine = saveActiveTaskSnapshot(root, TENANT, { ...STATE, session_id: 'sA' }, ALICE);
    saveActiveTaskSnapshot(root, TENANT, { task: 'Bob task', summary: 'b', next_step: 'b', session_id: 'sB' }, BOB);
    const { stdout } = await resume(owned('alice'));
    expect(stdout).toBe(compactResumeText(mine, []));
    expect(stdout).not.toContain('Bob task');
    withDb((db) => expect(count(db, 'token_ledger', `tenant_id = ? AND session_id = 'sA' AND surface = 'compact_resume' AND event = 'inject'`, TENANT)).toBe(1));
  });
});

describe('saveCompactionItemsForCaller', () => {
  it('writes with ownerOrSubject as actor and the project as origin', async () => {
    expect(await postCompact(owned('alice'))).toEqual({ written: 2 });
    const unowned: Context = { hippoRoot: root, store: sqliteStore(root), tenantId: TENANT, actor: { subject: 'api_key:hk_carol', role: 'member' }, reach: SHARED_REACH };
    await saveCompactionItemsForCaller(unowned, { sessionId: 'sC', project: { name: 'acme/web', legacyName: 'web' }, trigger: 'auto', items: [ITEMS[0]], requestId: 'cmp-c' });
    withDb((db) => {
      expect(writtenRows(db, 'compaction:sA')).toEqual([
        { content: ITEMS[1], origin_project: 'acme/app', actor: 'alice' },
        { content: ITEMS[0], origin_project: 'acme/app', actor: 'alice' },
      ]);
      expect(writtenRows(db, 'compaction:sC')).toEqual([{ content: ITEMS[0], origin_project: 'acme/web', actor: 'api_key:hk_carol' }]);
      expect(count(db, 'compactions', `session_id = 'sA' AND status = 'done' AND request_id = 'cmp-1' AND origin_project = 'acme/app'`)).toBe(1);
    });
  });

  it("held rows read from the caller's project", async () => {
    seed(ITEMS[0], 'app');
    seed(ITEMS[1], 'other/project');
    expect(await postCompact(owned('alice'))).toEqual({ written: 1 });
    withDb((db) => expect(writtenRows(db, 'compaction:sA')).toEqual([{ content: ITEMS[1], origin_project: 'acme/app', actor: 'alice' }]));
  });

  it('holdout writes nothing', async () => {
    holdout();
    expect(await postCompact(owned('alice'))).toEqual({ written: 0 });
    expect(rowCounts()).toMatchObject({ compactions: 0, memories: 0 });
  });

  it('a repeat request_id writes nothing and returns the earlier result (F10)', async () => {
    expect(await postCompact(owned('alice'))).toEqual({ written: 2 });
    expect(await postCompact(owned('alice'))).toEqual({ written: 2 });
    expect(rowCounts()).toMatchObject({ compactions: 1, memories: 2 });
    // A new request id is a new compaction; its items are already held.
    expect(await postCompact(owned('alice'), 'cmp-2')).toEqual({ written: 0 });
    expect(rowCounts()).toMatchObject({ compactions: 2, memories: 2 });
  });

  it('a retry reuses the summarised record', async () => {
    const undo = failOn('memories', 'INSERT', 'items boom');
    await expect(postCompact(owned('alice'))).rejects.toThrow('items boom');
    undo();
    expect(await postCompact(owned('alice'))).toEqual({ written: 2 });
    withDb((db) => {
      expect(count(db, 'compactions')).toBe(1);
      expect(count(db, 'compactions', `status = 'done' AND items_written = 2 AND request_id = 'cmp-1'`)).toBe(1);
    });
  });

  it('cuts an item back to its cap after the scrub, so one a mask runs past the cap still becomes a row', async () => {
    const item = `Mail a@b.co before the deploy. ${ITEMS.join(' ')} ${ITEMS.join(' ')} ${ITEMS.join(' ')}`.slice(0, COMPACTION_ITEM_MAX_CHARS);
    expect(item).toHaveLength(COMPACTION_ITEM_MAX_CHARS);
    const req = { sessionId: 'sA', project: PROJECT, trigger: 'auto', items: [item], requestId: 'cmp-1' };
    expect(await saveCompactionItemsForCaller(owned('alice'), req)).toEqual({ written: 1 });
    const stored = item.replace('a@b.co', '[email]').slice(0, COMPACTION_ITEM_MAX_CHARS);
    withDb((db) => expect(writtenRows(db, 'compaction:sA').map((r) => r.content)).toEqual([stored]));
  });

  it('refuses an item past its cap before the scrub, naming the field, before it binds the session', async () => {
    const req = { sessionId: 'sA', project: PROJECT, trigger: 'auto', items: ['x'.repeat(COMPACTION_ITEM_MAX_CHARS + 1)], requestId: 'cmp-1' };
    const err = await caught(() => saveCompactionItemsForCaller(owned('alice'), req));
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err).toMatchObject({ status: 400, message: expect.stringMatching(/^items:/) });
    withDb((db) => expect(count(db, 'session_owners')).toBe(0));
  });

  it('busy throws, no spool file', async () => {
    bindSessionOwner(owned('alice'), 'sA');
    const err = await whileLocked(() => caught(() => postCompact(owned('alice'))));
    expect(isStoreBusy(err)).toBe(true);
    expect(fs.existsSync(path.join(root, 'compactions-spool'))).toBe(false);
    expect(rowCounts()).toMatchObject({ compactions: 0, memories: 0 });
  });

  it("summarises pre-compact's record and stamps the request id on it", async () => {
    await preCompact(owned('alice'));
    await postCompact(owned('alice'));
    withDb((db) => {
      expect(count(db, 'compactions')).toBe(1);
      expect(count(db, 'compactions', `request_id = 'cmp-1' AND status = 'done' AND snapshot_saved = 1`)).toBe(1);
    });
  });
});

describe('captureFailureForCaller', () => {
  it('lesson carries owner as actor and project origin, and the log row both', async () => {
    expect(await captureFailureForCaller(owned('alice'), failure())).toEqual({ outcome: 'stored' });
    withDb((db) => {
      expect(writtenRows(db, 'tool-failure')).toEqual([{ content: LESSON, origin_project: 'acme/app', actor: 'alice' }]);
      expect(failureRows(db)).toEqual([
        { outcome: 'stored', owner_subject: 'alice', origin_project: 'acme/app', request_id: 'fail-1', sig_hash: failureHash(LESSON), detail_hash: null },
      ]);
    });
  });

  it('repeat check is per project', async () => {
    expect((await captureFailureForCaller(owned('alice'), failure())).outcome).toBe('stored');
    expect((await captureFailureForCaller(owned('alice'), failure({ requestId: 'fail-2' }))).outcome).toBe('duplicate');
    const web = { name: 'acme/web', legacyName: 'web' };
    expect((await captureFailureForCaller(owned('bob'), failure({ sessionId: 'sB', project: web, requestId: 'fail-3' }))).outcome).toBe('stored');
  });

  it('a repeat request_id writes nothing and returns the earlier result (F10)', async () => {
    expect((await captureFailureForCaller(owned('alice'), failure())).outcome).toBe('stored');
    expect((await captureFailureForCaller(owned('alice'), failure())).outcome).toBe('stored');
    expect(rowCounts()).toMatchObject({ failure_log: 1, memories: 1 });
  });

  it('a retry after a failed store stores the lesson and settles its log row', async () => {
    const undo = failOn('memories', 'INSERT', 'store boom');
    await expect(captureFailureForCaller(owned('alice'), failure())).rejects.toThrow('store boom');
    withDb((db) => expect(failureRows(db).map((r) => r.outcome)).toEqual(['store-failed']));
    undo();
    expect((await captureFailureForCaller(owned('alice'), failure())).outcome).toBe('stored');
    withDb((db) => expect(failureRows(db).map((r) => r.outcome)).toEqual(['stored']));
  });

  it('detail_hash equals what logFailure stores for the same payload (F13)', async () => {
    const payload = {
      session_id: 'local-s',
      tool_name: 'Bash',
      error: 'npm run build failed: src/a.ts(12,3): error TS2304: Cannot find name foo',
      tool_input: { command: 'cd /repo && npm run build' },
    };
    await captureToolFailure(failureTarget(root, TENANT), payload);
    const report = failureReport(payload);
    await captureFailureForCaller(owned('alice'), failure({ tool: report.tool, text: report.text, skip: report.skip, rule: report.rule, detailHash: report.detail_hash }));
    withDb((db) => {
      const [local, caller] = failureRows(db);
      expect(local.detail_hash).toMatch(/^[0-9a-f]{16}$/);
      expect(caller).toMatchObject({ sig_hash: local.sig_hash, detail_hash: local.detail_hash, owner_subject: 'alice' });
    });
  });

  it('scrubs a sent text again and cuts it to 200 after the scrub, so a mask that runs longer still stores', async () => {
    const text = `Bash: mail to a@b.co failed. ${'Retry the deploy. '.repeat(10)}`.slice(0, 200);
    expect(text).toHaveLength(200);
    expect((await captureFailureForCaller(owned('alice'), failure({ text }))).outcome).toBe('stored');
    withDb((db) => {
      const [row] = writtenRows(db, 'tool-failure');
      expect(row?.content).toBe(`Bash: mail to [email] failed. ${'Retry the deploy. '.repeat(10)}`.slice(0, 200));
      expect(failureRows(db)[0]?.sig_hash).toBe(failureHash(row?.content ?? ''));
    });
  });

  it('cuts the scrubbed text on a code point, never inside a surrogate pair', async () => {
    // 200 sent; the mask adds one, so the emoji's halves land at 199 and 200 of the scrubbed text.
    const filler = 'Retry the deploy. '.repeat(10).slice(0, 169);
    const text = `Bash: mail to a@b.co failed. ${filler}\u{1F600}`;
    expect(text).toHaveLength(200);
    expect((await captureFailureForCaller(owned('alice'), failure({ text }))).outcome).toBe('stored');
    withDb((db) => expect(writtenRows(db, 'tool-failure')[0]?.content).toBe(`Bash: mail to [email] failed. ${filler}`));
  });

  it('log error never masks a store error', async () => {
    failOn('memories', 'INSERT', 'store boom');
    failOn('failure_log', 'INSERT', 'log boom');
    await expect(captureFailureForCaller(owned('alice'), failure())).rejects.toThrow('store boom');
  });

  it('logs a routine skip with its rule and stores no lesson', async () => {
    const req = failure({ tool: 'Grep', text: 'Grep: no matches found', skip: 'skipped-routine', rule: 'search-tool' });
    expect(await captureFailureForCaller(owned('alice'), req)).toEqual({ outcome: 'skipped-routine' });
    withDb((db) => {
      expect(count(db, 'memories')).toBe(0);
      expect(count(db, 'failure_log', `outcome = 'skipped-routine' AND skip_rule = 'search-tool'`)).toBe(1);
    });
  });

  it.each([
    ['a routine skip with no rule', failure({ skip: 'skipped-routine', rule: null }), 'rule'],
    ['a rule on a lesson', failure({ rule: 'declined' }), 'rule'],
    ['a detail hash that is not 16 hex', failure({ detailHash: 'xyz' }), 'detail hash'],
    ['a blank request id', failure({ requestId: '' }), 'request id'],
    ['text past 200 characters', failure({ text: 'x'.repeat(201) }), 'text'],
    ['a lesson with no text', failure({ text: null }), 'text'],
  ])('refuses %s, naming the field, before it binds the session', async (_what, req, field) => {
    const err = await caught(() => captureFailureForCaller(owned('alice'), req));
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err).toMatchObject({ status: 400, message: expect.stringMatching(new RegExp(`^${field}:`)) });
    withDb((db) => expect(count(db, 'session_owners')).toBe(0));
  });
});

describe('sessionEndHandoffForCaller', () => {
  it("writes the owner's handoff and closes only the owner's snapshot", async () => {
    const mine = saveActiveTaskSnapshot(root, TENANT, { ...STATE, session_id: 'sA' }, ALICE);
    // Bob's row names the same session id, so only the key keeps the close off it.
    const bobs = saveActiveTaskSnapshot(root, TENANT, { task: 'Bob task', summary: 'b', next_step: 'b', session_id: 'sA' }, BOB);
    expect(await sessionEnd(owned('alice'))).toEqual({ handoffWritten: true, snapshotsClosed: 1 });
    withDb((db) => {
      expect(snapshotRow(db, mine.id)?.status).toBe('session-ended');
      expect(snapshotRow(db, bobs.id)?.status).toBe('active');
      expect(handoffRows(db)).toEqual([{ session_id: 'sA', task_id: STATE.task, owner_subject: 'alice', origin_project: 'acme/app' }]);
    });
  });

  it('writes the handoff from the working state when the owner has no snapshot for the session', async () => {
    const req = { sessionId: 'sA', project: PROJECT, workingState: STATE, evidence: null };
    expect(await sessionEndHandoffForCaller(owned('alice'), req)).toEqual({ handoffWritten: true, snapshotsClosed: 0 });
    expect(await sessionEndHandoffForCaller(owned('alice'), req)).toEqual({ handoffWritten: false, snapshotsClosed: 0 });
    withDb((db) => expect(handoffRows(db)).toEqual([{ session_id: 'sA', task_id: STATE.task, owner_subject: 'alice', origin_project: 'acme/app' }]));
  });

  it('retry after a failed close writes no second handoff', async () => {
    const mine = saveActiveTaskSnapshot(root, TENANT, { ...STATE, session_id: 'sA' }, ALICE);
    // An earlier save time, so the handoff is strictly newer than the snapshot it covers.
    withDb((db) => db.prepare(`UPDATE task_snapshots SET updated_at = ? WHERE id = ?`).run(new Date(Date.now() - 60_000).toISOString(), mine.id));
    const undo = failOn('task_snapshots', 'UPDATE', 'close boom');
    await expect(sessionEnd(owned('alice'))).rejects.toThrow('close boom');
    undo();
    expect(await sessionEnd(owned('alice'))).toEqual({ handoffWritten: false, snapshotsClosed: 1 });
    withDb((db) => {
      expect(handoffRows(db)).toHaveLength(1);
      expect(snapshotRow(db, mine.id)?.status).toBe('session-ended');
    });
  });

  it('refuses a git ref that is not a commit id, naming the field', async () => {
    const evidence = { gitRef: 'main', dirtyTree: null, testStatus: null };
    const err = await caught(() => sessionEndHandoffForCaller(owned('alice'), { sessionId: 'sA', project: PROJECT, workingState: null, evidence }));
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err).toMatchObject({ status: 400, message: expect.stringMatching(/^evidence gitRef:/) });
  });
});

describe('a second owner on the same session', () => {
  const calls: Array<[string, (ctx: Context) => object]> = [
    ['pre-compact', (ctx) => preCompact(ctx)],
    ['compact-resume', (ctx) => compactResumeForCaller(ctx, { sessionId: 'sA', project: PROJECT, source: 'compact' })],
    ['post-compact', (ctx) => postCompact(ctx)],
    ['capture-error', (ctx) => captureFailureForCaller(ctx, failure())],
    ['session end', (ctx) => sessionEndHandoffForCaller(ctx, { sessionId: 'sA', project: PROJECT, workingState: STATE, evidence: null })],
  ];

  it.each(calls)('%s: a second owner on the same session gets a 409 ConflictError', async (_name, call) => {
    bindSessionOwner(owned('alice'), 'sA');
    const err = await caught(() => call(owned('bob')));
    expect(err).toBeInstanceOf(ConflictError);
    expect(err).toMatchObject({ status: 409 });
    expect(rowCounts()).toEqual({ compactions: 0, task_snapshots: 0, session_handoffs: 0, failure_log: 0, memories: 0 });
    // The session's own owner still gets through.
    expect(await caught(() => call(owned('alice')))).toBeNull();
  });
});

describe('a request id another session sent', () => {
  const senders: Array<[string, string, string]> = [
    ['another session of the same owner', 'alice', 'sA2'],
    ['another owner', 'bob', 'sB'],
  ];
  const items = (owner: string, sessionId: string, list: readonly string[] = ITEMS) =>
    saveCompactionItemsForCaller(owned(owner), { sessionId, project: PROJECT, trigger: 'auto', items: list, requestId: 'cmp-1' });

  it('capture-error: the same id with a different body from the same session gets the first outcome and writes nothing', async () => {
    expect((await captureFailureForCaller(owned('alice'), failure())).outcome).toBe('stored');
    const other = failure({ tool: 'Grep', text: 'Grep: no matches found', skip: 'skipped-routine', rule: 'search-tool' });
    expect(await captureFailureForCaller(owned('alice'), other)).toEqual({ outcome: 'stored' });
    expect(rowCounts()).toMatchObject({ failure_log: 1, memories: 1 });
  });

  it.each(senders)('capture-error: the same id from %s is a 409 and leaves the first row alone', async (_who, owner, sessionId) => {
    // A failed first store leaves a row a retry settles, which a foreign id would otherwise rewrite.
    const undo = failOn('memories', 'INSERT', 'store boom');
    await expect(captureFailureForCaller(owned('alice'), failure())).rejects.toThrow('store boom');
    undo();
    const err = await caught(() => captureFailureForCaller(owned(owner), failure({ sessionId })));
    expect(err).toBeInstanceOf(ConflictError);
    expect(err).toMatchObject({ status: 409, message: 'request id belongs to another session' });
    withDb((db) => expect(failureRows(db)).toEqual([expect.objectContaining({ outcome: 'store-failed', owner_subject: 'alice' })]));
    expect(rowCounts()).toMatchObject({ failure_log: 1, memories: 0 });
    expect((await captureFailureForCaller(owned('alice'), failure())).outcome).toBe('stored');
  });

  it('post-compact: the same id with different items from the same session gets the first count and writes none of them', async () => {
    expect(await items('alice', 'sA')).toEqual({ written: 2 });
    expect(await items('alice', 'sA', ['The staging deploy needs the VPN up first or the health check times out.'])).toEqual({ written: 2 });
    expect(rowCounts()).toMatchObject({ compactions: 1, memories: 2 });
  });

  it.each(senders)('post-compact: the same id from %s is a 409 and never finishes the first record', async (_who, owner, sessionId) => {
    // Items that failed leave the record summarized, which a foreign id would otherwise finish under its own session.
    const undo = failOn('memories', 'INSERT', 'items boom');
    await expect(items('alice', 'sA')).rejects.toThrow('items boom');
    undo();
    const err = await caught(() => items(owner, sessionId));
    expect(err).toBeInstanceOf(ConflictError);
    expect(err).toMatchObject({ status: 409, message: 'request id belongs to another session' });
    withDb((db) => expect(count(db, 'compactions', `status = 'summarised' AND session_id = 'sA'`)).toBe(1));
    expect(rowCounts()).toMatchObject({ compactions: 1, memories: 0 });
    expect(await items('alice', 'sA')).toEqual({ written: 2 });
  });
});
