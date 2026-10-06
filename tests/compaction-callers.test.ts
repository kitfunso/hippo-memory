// The seams a server uses to save another machine's compaction and failures: its project, actor, tenant and request id, never the server's own.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadContentsWithTag } from '../src/store/entry-reads.js';
import { closeHippoDb, isStoreBusy, openHippoDb, withBusyWait, type DatabaseSyncLike } from '../src/db.js';
import { tableHasColumn } from '../src/db/tables.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { _resetSharedStoreCacheForTests } from '../src/config.js';
import { clearProjectIdentityCache } from '../src/project-identity.js';
import { markSnapshotSaved, PRE_COMPACT_INSTRUCTION, recordSnapshotSaved, recordSummary, saveItems, startCompaction, type ItemContext } from '../src/compaction-record.js';
import { captureToolFailure, storeLesson } from '../src/capture-error.js';
import { failureHash, failureReport } from '../src/capture/failure-reading.js';
import { WORKING_STATE_CAPS } from '../src/capture/working-state.js';
import { compactResumeText } from '../src/context-render.js';
import { loadActiveTaskSnapshot, saveActiveTaskSnapshot, type ContinuityKey } from '../src/store/sessions.js';
import { BadRequestError, ConflictError } from '../src/api-errors.js';
import type { Context } from '../src/api/types.js';
import {
  bindSessionOwner,
  captureFailureForCaller,
  compactResumeForCaller,
  preCompactForCaller,
  saveCompactionItemsForCaller,
  sessionEndHandoffForCaller,
  type CallerFailureRequest,
} from '../src/server.js';

const TENANT = 'acme-tenant';
const META = { sessionId: 's1', trigger: 'auto', cwd: null, transcriptPath: null };
const CALLER = { actor: 'alice@acme', origins: ['acme/app', 'app'] } as const;
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

function owned(owner: string): Context {
  return { hippoRoot: root, tenantId: TENANT, actor: { subject: `api_key:hk_${owner}`, role: 'member', owner } };
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
function whileLocked<T>(fn: () => T): T {
  const holder = openHippoDb(root);
  holder.exec('BEGIN IMMEDIATE');
  try {
    return withBusyWait(50, fn);
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

function thrown(fn: () => void): Error | null {
  try {
    fn();
  } catch (err) {
    if (err instanceof Error) return err;
    throw err;
  }
  return null;
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

describe('preCompactForCaller', () => {
  it("saves the owner's snapshot and returns the instruction", () => {
    const bobs = saveActiveTaskSnapshot(root, TENANT, { task: 'Bob task', summary: 'b', next_step: 'b', session_id: 'sB' }, BOB);
    expect(preCompact(owned('alice'))).toEqual({ stdout: PRE_COMPACT_INSTRUCTION });
    const mine = loadActiveTaskSnapshot(root, TENANT, ALICE);
    expect(mine).toMatchObject({ ...STATE, source: 'pre-compact', session_id: 'sA' });
    withDb((db) => expect(snapshotRow(db, mine?.id ?? 0)).toMatchObject({ owner_subject: 'alice', origin_project: 'acme/app' }));
    // The save superseded only Alice's rows: Bob's own row is still his active one.
    expect(loadActiveTaskSnapshot(root, TENANT, BOB)?.id).toBe(bobs.id);
  });

  it("keeps the owner's earlier field for the same session when a sent field is empty", () => {
    saveActiveTaskSnapshot(root, TENANT, { task: 'Earlier task', summary: 'old', next_step: 'Earlier step', session_id: 'sA' }, ALICE);
    preCompact(owned('alice'), { task: '', summary: 'New summary', next_step: '' });
    expect(loadActiveTaskSnapshot(root, TENANT, ALICE)).toMatchObject({ task: 'Earlier task', summary: 'New summary', next_step: 'Earlier step' });
  });

  it("holdout gives '' and writes no snapshot", () => {
    holdout();
    expect(preCompact(owned('alice'))).toEqual({ stdout: '' });
    expect(rowCounts()).toMatchObject({ compactions: 0, task_snapshots: 0 });
  });

  it('an over-cap field names the field', () => {
    const summary = 'x'.repeat(WORKING_STATE_CAPS.summary + 1);
    const err = thrown(() => preCompact(owned('alice'), { ...STATE, summary }));
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err).toMatchObject({ status: 400, message: `working state summary: at most ${WORKING_STATE_CAPS.summary} characters` });
    expect(preCompact(owned('alice'), { ...STATE, summary: summary.slice(1) })).toEqual({ stdout: PRE_COMPACT_INSTRUCTION });
  });

  it('a snapshot failure still returns the instruction', () => {
    failOn('task_snapshots', 'INSERT', 'snapshot boom');
    expect(preCompact(owned('alice'))).toEqual({ stdout: PRE_COMPACT_INSTRUCTION });
    withDb((db) => {
      expect(count(db, 'task_snapshots')).toBe(0);
      expect(count(db, 'compactions', 'tenant_id = ? AND snapshot_saved = 0', TENANT)).toBe(1);
    });
  });

  it('a busy store at startCompaction still returns the instruction (F8)', () => {
    bindSessionOwner(owned('alice'), 'sA');
    expect(whileLocked(() => preCompact(owned('alice')))).toEqual({ stdout: PRE_COMPACT_INSTRUCTION });
    expect(rowCounts()).toMatchObject({ compactions: 0, task_snapshots: 0 });
  });

  it('snapshot_saved = 1 on the ctx.tenantId record, whatever the environment names (F9)', () => {
    vi.stubEnv('HIPPO_TENANT', 'env-tenant');
    preCompact(owned('alice'));
    withDb((db) => {
      expect(count(db, 'compactions', `tenant_id = ? AND snapshot_saved = 1 AND origin_project = 'acme/app' AND cwd IS NULL`, TENANT)).toBe(1);
      expect(count(db, 'compactions', 'tenant_id = ?', 'env-tenant')).toBe(0);
    });
  });
});

describe('compactResumeForCaller', () => {
  const resume = (ctx: Context, source = 'compact') => compactResumeForCaller(ctx, { sessionId: 'sA', project: PROJECT, source });

  it("source not compact gives ''", () => {
    saveActiveTaskSnapshot(root, TENANT, { ...STATE, session_id: 'sA' }, ALICE);
    expect(resume(owned('alice'), 'startup')).toEqual({ stdout: '' });
    expect(resume(owned('alice')).stdout).toContain(STATE.task);
  });

  it("holdout gives ''", () => {
    saveActiveTaskSnapshot(root, TENANT, { ...STATE, session_id: 'sA' }, ALICE);
    holdout();
    expect(resume(owned('alice'))).toEqual({ stdout: '' });
  });

  it("another session's snapshot gives ''", () => {
    saveActiveTaskSnapshot(root, TENANT, { ...STATE, session_id: 'sOld' }, ALICE);
    expect(resume(owned('alice'))).toEqual({ stdout: '' });
  });

  it("renders the owner's snapshot and books one compact_resume row", () => {
    const mine = saveActiveTaskSnapshot(root, TENANT, { ...STATE, session_id: 'sA' }, ALICE);
    saveActiveTaskSnapshot(root, TENANT, { task: 'Bob task', summary: 'b', next_step: 'b', session_id: 'sB' }, BOB);
    const { stdout } = resume(owned('alice'));
    expect(stdout).toBe(compactResumeText(mine, []));
    expect(stdout).not.toContain('Bob task');
    withDb((db) => expect(count(db, 'token_ledger', `tenant_id = ? AND session_id = 'sA' AND surface = 'compact_resume' AND event = 'inject'`, TENANT)).toBe(1));
  });
});

describe('saveCompactionItemsForCaller', () => {
  it('writes with ownerOrSubject as actor and the project as origin', () => {
    expect(postCompact(owned('alice'))).toEqual({ written: 2 });
    const unowned: Context = { hippoRoot: root, tenantId: TENANT, actor: { subject: 'api_key:hk_carol', role: 'member' } };
    saveCompactionItemsForCaller(unowned, { sessionId: 'sC', project: { name: 'acme/web', legacyName: 'web' }, trigger: 'auto', items: [ITEMS[0]], requestId: 'cmp-c' });
    withDb((db) => {
      expect(writtenRows(db, 'compaction:sA')).toEqual([
        { content: ITEMS[1], origin_project: 'acme/app', actor: 'alice' },
        { content: ITEMS[0], origin_project: 'acme/app', actor: 'alice' },
      ]);
      expect(writtenRows(db, 'compaction:sC')).toEqual([{ content: ITEMS[0], origin_project: 'acme/web', actor: 'api_key:hk_carol' }]);
      expect(count(db, 'compactions', `session_id = 'sA' AND status = 'done' AND request_id = 'cmp-1' AND origin_project = 'acme/app'`)).toBe(1);
    });
  });

  it("held rows read from the caller's project", () => {
    seed(ITEMS[0], 'app');
    seed(ITEMS[1], 'other/project');
    expect(postCompact(owned('alice'))).toEqual({ written: 1 });
    withDb((db) => expect(writtenRows(db, 'compaction:sA')).toEqual([{ content: ITEMS[1], origin_project: 'acme/app', actor: 'alice' }]));
  });

  it('holdout writes nothing', () => {
    holdout();
    expect(postCompact(owned('alice'))).toEqual({ written: 0 });
    expect(rowCounts()).toMatchObject({ compactions: 0, memories: 0 });
  });

  it('a repeat request_id writes nothing and returns the earlier result (F10)', () => {
    expect(postCompact(owned('alice'))).toEqual({ written: 2 });
    expect(postCompact(owned('alice'))).toEqual({ written: 2 });
    expect(rowCounts()).toMatchObject({ compactions: 1, memories: 2 });
    // A new request id is a new compaction; its items are already held.
    expect(postCompact(owned('alice'), 'cmp-2')).toEqual({ written: 0 });
    expect(rowCounts()).toMatchObject({ compactions: 2, memories: 2 });
  });

  it('a retry reuses the summarised record', () => {
    const undo = failOn('memories', 'INSERT', 'items boom');
    expect(() => postCompact(owned('alice'))).toThrow('items boom');
    undo();
    expect(postCompact(owned('alice'))).toEqual({ written: 2 });
    withDb((db) => {
      expect(count(db, 'compactions')).toBe(1);
      expect(count(db, 'compactions', `status = 'done' AND items_written = 2 AND request_id = 'cmp-1'`)).toBe(1);
    });
  });

  it('busy throws, no spool file', () => {
    bindSessionOwner(owned('alice'), 'sA');
    const err = whileLocked(() => thrown(() => postCompact(owned('alice'))));
    expect(isStoreBusy(err)).toBe(true);
    expect(fs.existsSync(path.join(root, 'compactions-spool'))).toBe(false);
    expect(rowCounts()).toMatchObject({ compactions: 0, memories: 0 });
  });

  it("summarises pre-compact's record and stamps the request id on it", () => {
    preCompact(owned('alice'));
    postCompact(owned('alice'));
    withDb((db) => {
      expect(count(db, 'compactions')).toBe(1);
      expect(count(db, 'compactions', `request_id = 'cmp-1' AND status = 'done' AND snapshot_saved = 1`)).toBe(1);
    });
  });
});

describe('captureFailureForCaller', () => {
  it('lesson carries owner as actor and project origin, and the log row both', () => {
    expect(captureFailureForCaller(owned('alice'), failure())).toEqual({ outcome: 'stored' });
    withDb((db) => {
      expect(writtenRows(db, 'tool-failure')).toEqual([{ content: LESSON, origin_project: 'acme/app', actor: 'alice' }]);
      expect(failureRows(db)).toEqual([
        { outcome: 'stored', owner_subject: 'alice', origin_project: 'acme/app', request_id: 'fail-1', sig_hash: failureHash(LESSON), detail_hash: null },
      ]);
    });
  });

  it('repeat check is per project', () => {
    expect(captureFailureForCaller(owned('alice'), failure()).outcome).toBe('stored');
    expect(captureFailureForCaller(owned('alice'), failure({ requestId: 'fail-2' })).outcome).toBe('duplicate');
    const web = { name: 'acme/web', legacyName: 'web' };
    expect(captureFailureForCaller(owned('bob'), failure({ sessionId: 'sB', project: web, requestId: 'fail-3' })).outcome).toBe('stored');
  });

  it('a repeat request_id writes nothing and returns the earlier result (F10)', () => {
    expect(captureFailureForCaller(owned('alice'), failure()).outcome).toBe('stored');
    expect(captureFailureForCaller(owned('alice'), failure()).outcome).toBe('stored');
    expect(rowCounts()).toMatchObject({ failure_log: 1, memories: 1 });
  });

  it('a retry after a failed store stores the lesson and settles its log row', () => {
    const undo = failOn('memories', 'INSERT', 'store boom');
    expect(() => captureFailureForCaller(owned('alice'), failure())).toThrow('store boom');
    withDb((db) => expect(failureRows(db).map((r) => r.outcome)).toEqual(['store-failed']));
    undo();
    expect(captureFailureForCaller(owned('alice'), failure()).outcome).toBe('stored');
    withDb((db) => expect(failureRows(db).map((r) => r.outcome)).toEqual(['stored']));
  });

  it('detail_hash equals what logFailure stores for the same payload (F13)', () => {
    const payload = {
      session_id: 'local-s',
      tool_name: 'Bash',
      error: 'npm run build failed: src/a.ts(12,3): error TS2304: Cannot find name foo',
      tool_input: { command: 'cd /repo && npm run build' },
    };
    captureToolFailure(root, TENANT, payload);
    const report = failureReport(payload);
    captureFailureForCaller(owned('alice'), failure({ tool: report.tool, text: report.text, skip: report.skip, rule: report.rule, detailHash: report.detail_hash }));
    withDb((db) => {
      const [local, caller] = failureRows(db);
      expect(local.detail_hash).toMatch(/^[0-9a-f]{16}$/);
      expect(caller).toMatchObject({ sig_hash: local.sig_hash, detail_hash: local.detail_hash, owner_subject: 'alice' });
    });
  });

  it('log error never masks a store error', () => {
    failOn('memories', 'INSERT', 'store boom');
    failOn('failure_log', 'INSERT', 'log boom');
    expect(() => captureFailureForCaller(owned('alice'), failure())).toThrow('store boom');
  });

  it('logs a routine skip with its rule and stores no lesson', () => {
    const req = failure({ tool: 'Grep', text: 'Grep: no matches found', skip: 'skipped-routine', rule: 'search-tool' });
    expect(captureFailureForCaller(owned('alice'), req)).toEqual({ outcome: 'skipped-routine' });
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
  ])('refuses %s, naming the field, before it binds the session', (_what, req, field) => {
    const err = thrown(() => captureFailureForCaller(owned('alice'), req));
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err).toMatchObject({ status: 400, message: expect.stringMatching(new RegExp(`^${field}:`)) });
    withDb((db) => expect(count(db, 'session_owners')).toBe(0));
  });
});

describe('sessionEndHandoffForCaller', () => {
  it("writes the owner's handoff and closes only the owner's snapshot", () => {
    const mine = saveActiveTaskSnapshot(root, TENANT, { ...STATE, session_id: 'sA' }, ALICE);
    // Bob's row names the same session id, so only the key keeps the close off it.
    const bobs = saveActiveTaskSnapshot(root, TENANT, { task: 'Bob task', summary: 'b', next_step: 'b', session_id: 'sA' }, BOB);
    expect(sessionEnd(owned('alice'))).toEqual({ handoffWritten: true, snapshotsClosed: 1 });
    withDb((db) => {
      expect(snapshotRow(db, mine.id)?.status).toBe('session-ended');
      expect(snapshotRow(db, bobs.id)?.status).toBe('active');
      expect(handoffRows(db)).toEqual([{ session_id: 'sA', task_id: STATE.task, owner_subject: 'alice', origin_project: 'acme/app' }]);
    });
  });

  it('writes the handoff from the working state when the owner has no snapshot for the session', () => {
    const req = { sessionId: 'sA', project: PROJECT, workingState: STATE, evidence: null };
    expect(sessionEndHandoffForCaller(owned('alice'), req)).toEqual({ handoffWritten: true, snapshotsClosed: 0 });
    expect(sessionEndHandoffForCaller(owned('alice'), req)).toEqual({ handoffWritten: false, snapshotsClosed: 0 });
    withDb((db) => expect(handoffRows(db)).toEqual([{ session_id: 'sA', task_id: STATE.task, owner_subject: 'alice', origin_project: 'acme/app' }]));
  });

  it('retry after a failed close writes no second handoff', () => {
    const mine = saveActiveTaskSnapshot(root, TENANT, { ...STATE, session_id: 'sA' }, ALICE);
    // An earlier save time, so the handoff is strictly newer than the snapshot it covers.
    withDb((db) => db.prepare(`UPDATE task_snapshots SET updated_at = ? WHERE id = ?`).run(new Date(Date.now() - 60_000).toISOString(), mine.id));
    const undo = failOn('task_snapshots', 'UPDATE', 'close boom');
    expect(() => sessionEnd(owned('alice'))).toThrow('close boom');
    undo();
    expect(sessionEnd(owned('alice'))).toEqual({ handoffWritten: false, snapshotsClosed: 1 });
    withDb((db) => {
      expect(handoffRows(db)).toHaveLength(1);
      expect(snapshotRow(db, mine.id)?.status).toBe('session-ended');
    });
  });

  it('refuses a git ref that is not a commit id, naming the field', () => {
    const evidence = { gitRef: 'main', dirtyTree: null, testStatus: null };
    const err = thrown(() => sessionEndHandoffForCaller(owned('alice'), { sessionId: 'sA', project: PROJECT, workingState: null, evidence }));
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err).toMatchObject({ status: 400, message: expect.stringMatching(/^evidence gitRef:/) });
  });
});

describe('a second owner on the same session', () => {
  const calls: Array<[string, (ctx: Context) => void]> = [
    ['pre-compact', (ctx) => preCompact(ctx)],
    ['compact-resume', (ctx) => compactResumeForCaller(ctx, { sessionId: 'sA', project: PROJECT, source: 'compact' })],
    ['post-compact', (ctx) => postCompact(ctx)],
    ['capture-error', (ctx) => captureFailureForCaller(ctx, failure())],
    ['session end', (ctx) => sessionEndHandoffForCaller(ctx, { sessionId: 'sA', project: PROJECT, workingState: STATE, evidence: null })],
  ];

  it.each(calls)('%s: a second owner on the same session gets a 409 ConflictError', (_name, call) => {
    bindSessionOwner(owned('alice'), 'sA');
    const err = thrown(() => call(owned('bob')));
    expect(err).toBeInstanceOf(ConflictError);
    expect(err).toMatchObject({ status: 409 });
    expect(rowCounts()).toEqual({ compactions: 0, task_snapshots: 0, session_handoffs: 0, failure_log: 0, memories: 0 });
    // The session's own owner still gets through.
    expect(thrown(() => call(owned('alice')))).toBeNull();
  });
});
