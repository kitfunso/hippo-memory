// The five caller calls key every row on ctx.tenantId and the body's project, never HIPPO_TENANT or the folder the server runs in.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { loadConfig } from '../../src/core/config.js';
import { PRE_COMPACT_INSTRUCTION } from '../../src/capture/compaction-record.js';
import type { Context } from '../../src/api/types.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import {
  captureFailureForCaller,
  compactResumeForCaller,
  preCompactForCaller,
  saveCompactionItemsForCaller,
  sessionEndHandoffForCaller,
} from '../../src/server.js';
import { makeRoot } from '../_helpers/make-root.js';
import { initTestStore } from '../_helpers/store-template.js';

const TENANT = 'acme-tenant';
const ENV_TENANT = 'env-tenant';
const SESSION = 'sA';
const PROJECT = { name: 'acme/app', legacyName: 'app' } as const;
const STATE = { task: 'Ship the caller calls', summary: 'Wrote the tests first.', next_step: 'Implement pre-compact' };
const ITEMS = [
  'The release script must run from the repo root because it reads the env file by a relative path.',
  'Integration tests need the local Postgres container started before the suite or every case times out.',
];
const LESSON = 'Bash: npm run build failed: src/a.ts(12,3): error TS2304: Cannot find name foo';
const TENANT_TABLES = [
  'compactions',
  'task_snapshots',
  'session_handoffs',
  'failure_log',
  'memories',
  'token_ledger',
  'session_owners',
] as const;
const ORIGIN_TABLES = ['compactions', 'task_snapshots', 'session_handoffs', 'failure_log', 'memories'] as const;

let dir: string;
let root: string;
let startCwd: string;

beforeEach(() => {
  dir = makeRoot('caller-no-env', { init: false });
  for (const name of ['HOME', 'USERPROFILE', 'HIPPO_HOME']) vi.stubEnv(name, dir);
  vi.stubEnv('HIPPO_TENANT', ENV_TENANT);
  root = path.join(dir, 'server', '.hippo');
  fs.mkdirSync(root, { recursive: true });
  initTestStore(root);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ sharedStore: true }));
  // A folder outside any repo, so a call that fell back to the process folder would stamp its name.
  const elsewhere = path.join(dir, 'elsewhere');
  fs.mkdirSync(elsewhere);
  startCwd = process.cwd();
  process.chdir(elsewhere);
});

afterEach(() => {
  process.chdir(startCwd);
  vi.unstubAllEnvs();
});

function withDb<T>(fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

function rowsByTenant(db: DatabaseSyncLike, tenantId: string): Record<string, number> {
  return Object.fromEntries(
    TENANT_TABLES.map((t) => [
      t,
      db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE tenant_id = ?`).get<{ n: number }>(tenantId).n,
    ]),
  );
}

function origins(db: DatabaseSyncLike, table: string): string[] {
  // SAFETY: the SELECT names exactly one TEXT column.
  const rows = db
    .prepare(`SELECT DISTINCT origin_project FROM ${table} WHERE origin_project IS NOT NULL ORDER BY origin_project`)
    .all() as Array<{ origin_project: string }>;
  return rows.map((r) => r.origin_project);
}

describe('caller calls under a foreign environment', () => {
  it("each of the five calls writes only to ctx.tenantId and the body's project", async () => {
    const ctx: Context = {
      hippoRoot: root,
      store: sqliteStore(root),
      config: loadConfig(root),
      tenantId: TENANT,
      actor: { subject: 'api_key:hk_alice', role: 'member', owner: 'alice' },
      reach: { hasLocal: true, isGlobal: false, shared: true },
    };
    const base = { sessionId: SESSION, project: PROJECT };

    expect(await preCompactForCaller(ctx, { ...base, trigger: 'auto', workingState: STATE })).toEqual({
      stdout: PRE_COMPACT_INSTRUCTION,
    });
    expect((await compactResumeForCaller(ctx, { ...base, source: 'compact' })).stdout).toContain(STATE.task);
    expect(
      await saveCompactionItemsForCaller(ctx, { ...base, trigger: 'auto', items: ITEMS, requestId: 'cmp-1' }),
    ).toEqual({ written: 2 });
    expect(
      await captureFailureForCaller(ctx, {
        ...base,
        tool: 'Bash',
        text: LESSON,
        skip: null,
        rule: null,
        detailHash: null,
        requestId: 'fail-1',
      }),
    ).toEqual({ outcome: 'stored' });
    const evidence = { gitRef: 'b'.repeat(40), dirtyTree: true, testStatus: 'pass' } as const;
    expect(await sessionEndHandoffForCaller(ctx, { ...base, workingState: STATE, evidence })).toEqual({
      handoffWritten: true,
      snapshotsClosed: 1,
    });

    withDb((db) => {
      expect(rowsByTenant(db, TENANT)).toEqual({
        compactions: 1,
        task_snapshots: 1,
        session_handoffs: 1,
        failure_log: 1,
        memories: 3,
        token_ledger: 1,
        session_owners: 1,
      });
      expect(Object.values(rowsByTenant(db, ENV_TENANT)).every((n) => n === 0)).toBe(true);
      for (const table of ORIGIN_TABLES) expect([table, origins(db, table)]).toEqual([table, ['acme/app']]);
      expect(db.prepare(`SELECT snapshot_saved, status FROM compactions WHERE tenant_id = ?`).get(TENANT)).toEqual({
        snapshot_saved: 1,
        status: 'done',
      });
    });
  });
});
