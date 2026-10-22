// Store, caller contexts and row readers the compaction caller tests share; useCallerStore gives each case a fresh server store.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import { closeHippoDb, openHippoDb, runWithRequestStores, type DatabaseSyncLike } from '../../src/db/index.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { loadConfig } from '../../src/host/config-file.js';
import type { Context, ContextReach } from '../../src/api/types.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import {
  preCompactForCaller,
  saveCompactionItemsForCaller,
  sessionEndHandoffForCaller,
  type CallerFailureRequest,
} from '../../src/server.js';
import { makeRoot } from './make-root.js';
import { writeEntry } from './root-forms.js';
import type { ContinuityKey } from '../../src/store/port/types.js';
import { initTestStore } from './store-template.js';

// A server ctx carries a reach from its composition root; the ledger books nowhere without one.
export const SHARED_REACH: ContextReach = { hasLocal: true, isGlobal: false, shared: true };

export const TENANT = 'acme-tenant';
export const META = { sessionId: 's1', trigger: 'auto', cwd: null, transcriptPath: null };
export const noLog = (): void => {};
export const PROJECT = { name: 'acme/app', legacyName: 'app' } as const;
export const ALICE: ContinuityKey = { owner: 'alice', project: ['acme/app', 'app'] };
export const BOB: ContinuityKey = { owner: 'bob', project: ['acme/app', 'app'] };
export const STATE = {
  task: 'Ship the caller calls',
  summary: 'Wrote the tests first.',
  next_step: 'Implement pre-compact',
};
export const ITEMS = [
  'The release script must run from the repo root because it reads the env file by a relative path.',
  'Integration tests need the local Postgres container started before the suite or every case times out.',
];
export const LESSON = 'Bash: npm run build failed: src/a.ts(12,3): error TS2304: Cannot find name foo';

let dir: string;
export let root: string;

export function useCallerStore(): void {
  beforeEach(() => {
    dir = makeRoot('compaction-callers', { init: false });
    for (const name of ['HOME', 'USERPROFILE', 'HIPPO_HOME']) vi.stubEnv(name, dir);
    root = path.join(dir, 'server', '.hippo');
    fs.mkdirSync(root, { recursive: true });
    initTestStore(root);
    // A server's store: its own folder names no project, so nothing here may fall back to it.
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ sharedStore: true }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });
}

export function withDb<T>(fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
interface RecordRow {
  origin_project: string;
  status: string;
  snapshot_saved: number;
}

export function recordRow(db: DatabaseSyncLike, id: string): RecordRow | undefined {
  return db.prepare(`SELECT origin_project, status, snapshot_saved FROM compactions WHERE id = ?`).get(id) as
    | RecordRow
    | undefined;
}

export function seed(content: string, origin: string, tags: string[] = []): void {
  writeEntry(root, {
    ...createMemory(content, { tenantId: TENANT, tags, baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
    originProject: origin,
  });
}

interface WrittenRow {
  content: string;
  origin_project: string | null;
  actor: string;
}

export function writtenRows(db: DatabaseSyncLike, source: string): WrittenRow[] {
  // SAFETY: the SELECT names exactly WrittenRow's three columns.
  return db
    .prepare(
      `SELECT m.content, m.origin_project, a.actor FROM memories m JOIN audit_log a ON a.target_id = m.id AND a.op = 'remember'
     WHERE m.tenant_id = ? AND m.source = ? ORDER BY m.content`,
    )
    .all(TENANT, source) as WrittenRow[];
}

export function owned(owner: string): Context {
  return {
    store: sqliteStore(root),
    config: loadConfig(root),
    tenantId: TENANT,
    actor: { subject: `api_key:hk_${owner}`, role: 'member', owner },
    reach: SHARED_REACH,
  };
}

/** Every session lands in the holdout arm at 10000 basis points. */
export function holdout(): void {
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({ sharedStore: true, pilot: { holdoutRateBp: 10000 } }),
  );
}

/** A statement on `table` that fails, so a step's error path runs on the real store; returns the undo. */
export function failOn(table: string, when: 'INSERT' | 'UPDATE', message: string): () => void {
  const name = `fail_${table}_${when.toLowerCase()}`;
  withDb((db) =>
    db.exec(`CREATE TRIGGER ${name} BEFORE ${when} ON ${table} BEGIN SELECT RAISE(ABORT, '${message}'); END`),
  );
  return () => withDb((db) => db.exec(`DROP TRIGGER ${name}`));
}

/** Runs `fn` while another connection holds the write lock, with a 50 ms wait so busy shows fast. */
export async function whileLocked<T>(fn: () => T): Promise<T> {
  const holder = openHippoDb(root);
  holder.exec('BEGIN IMMEDIATE');
  try {
    return await runWithRequestStores(fn, { busyWaitMs: 50 });
  } finally {
    holder.exec('ROLLBACK');
    closeHippoDb(holder);
  }
}

export function count(db: DatabaseSyncLike, table: string, where = '1', ...params: string[]): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params) as { n: number }).n;
}

export const WRITTEN_TABLES = ['compactions', 'task_snapshots', 'session_handoffs', 'failure_log', 'memories'] as const;

export function rowCounts(): Record<string, number> {
  return withDb((db) => Object.fromEntries(WRITTEN_TABLES.map((t) => [t, count(db, t)])));
}

// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
interface SnapshotRow {
  id: number;
  status: string;
  owner_subject: string | null;
  origin_project: string | null;
}

export function snapshotRow(db: DatabaseSyncLike, id: number): SnapshotRow | undefined {
  return db.prepare(`SELECT id, status, owner_subject, origin_project FROM task_snapshots WHERE id = ?`).get(id) as
    | SnapshotRow
    | undefined;
}

interface FailureRow {
  outcome: string;
  owner_subject: string | null;
  origin_project: string | null;
  request_id: string | null;
  sig_hash: string | null;
  detail_hash: string | null;
}

export function failureRows(db: DatabaseSyncLike): FailureRow[] {
  // SAFETY: the SELECT names exactly FailureRow's six columns.
  return db
    .prepare(
      `SELECT outcome, owner_subject, origin_project, request_id, sig_hash, detail_hash FROM failure_log ORDER BY id`,
    )
    .all() as FailureRow[];
}

interface HandoffRow {
  session_id: string;
  task_id: string | null;
  owner_subject: string | null;
  origin_project: string | null;
}

export function handoffRows(db: DatabaseSyncLike): HandoffRow[] {
  // SAFETY: the SELECT names exactly HandoffRow's four columns.
  return db
    .prepare(`SELECT session_id, task_id, owner_subject, origin_project FROM session_handoffs ORDER BY id`)
    .all() as HandoffRow[];
}

export function failure(over: Partial<CallerFailureRequest> = {}): CallerFailureRequest {
  return {
    sessionId: 'sA',
    project: PROJECT,
    tool: 'Bash',
    text: LESSON,
    skip: null,
    rule: null,
    detailHash: null,
    requestId: 'fail-1',
    ...over,
  };
}

export const preCompact = (ctx: Context, workingState: typeof STATE | null = STATE) =>
  preCompactForCaller(ctx, { sessionId: 'sA', project: PROJECT, trigger: 'auto', workingState });
export const postCompact = (ctx: Context, requestId = 'cmp-1') =>
  saveCompactionItemsForCaller(ctx, { sessionId: 'sA', project: PROJECT, trigger: 'auto', items: ITEMS, requestId });
export const sessionEnd = (ctx: Context) =>
  sessionEndHandoffForCaller(ctx, {
    sessionId: 'sA',
    project: PROJECT,
    workingState: null,
    evidence: { gitRef: 'a'.repeat(40), dirtyTree: false, testStatus: 'unknown' },
  });

export async function caught(fn: () => object): Promise<Error | null> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof Error) return err;
    throw err;
  }
  return null;
}
