import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { createApiKey } from '../../src/store/sqlite/keys/auth.js';
import { listAuditEvents } from '../../src/store/sqlite/audit/audit.js';
import { remember, promote, supersede } from '../../src/api/index.js';
import { serve, type ServerHandle } from '../../src/server.js';
import { ConflictError } from '../../src/base/errors/api-errors.js';
import { makeRoot } from '../_helpers/make-root.js';
import { supersedeNow } from '../_helpers/supersede-now.js';
import { gateFirstWrite } from '../_helpers/write-gate.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { loadConfig } from '../../src/host/config-file.js';
import { readEntry } from '../_helpers/root-forms.js';
import { testInfra } from '../_helpers/infra.js';

function queryRow<T>(db: DatabaseSyncLike, sql: string, ...params: unknown[]): T | undefined {
  // SAFETY: each call site's SELECT explicitly lists the columns matching T.
  return db.prepare(sql).get(...params) as T | undefined;
}

describe('api tenant isolation', () => {
  let home: string;
  let globalHome: string;

  beforeEach(() => {
    home = makeRoot('api-tenant');
    globalHome = makeRoot('api-tenant-global');
    vi.stubEnv('HIPPO_HOME', globalHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(globalHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('promote refuses to promote a row that belongs to another tenant', async () => {
    const created = await remember(apiCtx(home, 'alpha', { subject: 'cli', role: 'admin' }), {
      content: 'alpha-row promote-cross-tenant canary',
    });

    await expect(
      promote(
        {
          store: sqliteStore(home),
          config: loadConfig(home),
          tenantId: 'bravo',
          actor: { subject: 'api_key:bravo-key', role: 'admin' },
          infra: testInfra(),
        },
        created.id,
      ),
    ).rejects.toThrow(/memory not found/i);

    const db = openHippoDb(home);
    try {
      const row = queryRow<{ tenant_id: string }>(db, `SELECT tenant_id FROM memories WHERE id = ?`, created.id);
      expect(row!.tenant_id).toBe('alpha');
    } finally {
      closeHippoDb(db);
    }

    const gdb = openHippoDb(globalHome);
    try {
      const grows = queryRow<{ c: number }>(gdb, `SELECT COUNT(*) AS c FROM memories`)!;
      expect(Number(grows.c)).toBe(0);
    } finally {
      closeHippoDb(gdb);
    }
  });

  it('supersede refuses the writer that read the row before another writer superseded it', async () => {
    const alpha = (): FullContext => apiCtx(home, 'alpha', { subject: 'cli', role: 'admin' });
    const created = await remember(alpha(), { content: 'alpha-row supersede CAS race canary' });

    const ctx = alpha();
    const { store } = ctx;
    const readAs: (string | null)[] = [];
    let successorId = '';
    const loser: FullContext = {
      ...ctx,
      store: {
        ...store,
        entriesByIds: async (...args) => {
          const rows = await store.entriesByIds(...args);
          readAs.push(...rows.map((row) => row.supersededBy));
          return rows;
        },
        entryWrites: {
          ...store.entryWrites,
          supersede: gateFirstWrite(
            (...args: Parameters<typeof store.entryWrites.supersede>) => store.entryWrites.supersede(...args),
            async () => {
              successorId = await supersedeNow(alpha(), created.id, 'the winner');
            },
          ),
        },
      },
    };
    const refused = supersede(loser, created.id, 'the loser');
    await expect(refused).rejects.toBeInstanceOf(ConflictError);
    await expect(refused).rejects.toThrow(`Memory ${created.id} already superseded by another writer`);
    expect(readAs).toEqual([null]);

    const db = openHippoDb(home);
    try {
      const old = queryRow<{ superseded_by: string | null }>(
        db,
        `SELECT superseded_by FROM memories WHERE id = ?`,
        created.id,
      );
      expect(old?.superseded_by).toBe(successorId);
      const rows = queryRow<{ c: number }>(db, `SELECT COUNT(*) AS c FROM memories WHERE tenant_id = 'alpha'`);
      expect(Number(rows?.c)).toBe(2);
      expect(listAuditEvents(db, { tenantId: 'alpha', op: 'supersede' }).map((e) => e.targetId)).toEqual([created.id]);
    } finally {
      closeHippoDb(db);
    }
    await expect(supersede(alpha(), created.id, 'a later writer')).rejects.toThrow(
      `is already superseded by ${successorId}`,
    );
  });

  it('supersede CAS clean path: both rows present, audit row written, chain pointer set', async () => {
    const created = await remember(apiCtx(home, 'alpha', { subject: 'cli', role: 'admin' }), {
      content: 'alpha-row supersede clean-path canary',
    });

    const result = await supersede(
      apiCtx(home, 'alpha', { subject: 'cli', role: 'admin' }),
      created.id,
      'fresh replacement content',
    );

    expect(result.ok).toBe(true);
    expect(result.oldId).toBe(created.id);
    expect(result.newId).toMatch(/^mem_/);

    const oldEntry = readEntry(home, created.id, 'alpha');
    expect(oldEntry).not.toBeNull();
    expect(oldEntry!.supersededBy).toBe(result.newId);

    const newEntry = readEntry(home, result.newId, 'alpha');
    expect(newEntry).not.toBeNull();
    expect(newEntry!.content).toBe('fresh replacement content');
    expect(newEntry!.tenantId).toBe('alpha');

    const db = openHippoDb(home);
    try {
      const supersedeEvents = listAuditEvents(db, { tenantId: 'alpha', op: 'supersede' });
      const supersedeRow = supersedeEvents.find((e) => e.targetId === created.id);
      // SAFETY: supersede() writes its audit_log row with metadata={ newId }
      // (see api.ts supersede()), so newId is present on this row.
      expect((supersedeRow!.metadata as { newId?: string }).newId).toBe(result.newId);

      const rememberEvents = listAuditEvents(db, { tenantId: 'alpha', op: 'remember' });
      const rememberRow = rememberEvents.find((e) => e.targetId === result.newId);
      expect(rememberRow?.targetId).toBe(result.newId);
    } finally {
      closeHippoDb(db);
    }
  });

  it('supersede across tenants throws "Memory not found" via readEntry tenant scope', async () => {
    const created = await remember(apiCtx(home, 'alpha', { subject: 'cli', role: 'admin' }), {
      content: 'alpha-row supersede tenant-scope canary',
    });

    await expect(
      supersede(
        apiCtx(home, 'bravo', { subject: 'api_key:bravo-key', role: 'admin' }),
        created.id,
        'cross-tenant supersede attempt',
      ),
    ).rejects.toThrow(/memory not found/i);

    const db = openHippoDb(home);
    try {
      const row = queryRow<{ tenant_id: string; superseded_by: string | null }>(
        db,
        `SELECT tenant_id, superseded_by FROM memories WHERE id = ?`,
        created.id,
      );
      expect(row!.tenant_id).toBe('alpha');
      expect(row!.superseded_by).toBeNull();

      const totalRows = queryRow<{ c: number }>(db, `SELECT COUNT(*) AS c FROM memories`)!;
      expect(Number(totalRows.c)).toBe(1);
    } finally {
      closeHippoDb(db);
    }
  });
});

describe('authCreate HTTP body.tenantId ignored', () => {
  let home: string;
  let globalHome: string;
  let handle: ServerHandle;

  beforeEach(async () => {
    home = makeRoot('api-authcreate');
    globalHome = makeRoot('api-authcreate-global');
    vi.stubEnv('HIPPO_HOME', globalHome);
    handle = await serve({ hippoRoot: home, port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(globalHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('POST /v1/auth/keys ignores body.tenantId, binds key to bearer tenant', async () => {
    const db = openHippoDb(home);
    let alphaPlaintext: string;
    try {
      const created = createApiKey(db, { tenantId: 'alpha', label: 'alpha-bootstrap', role: 'admin' });
      alphaPlaintext = created.plaintext;
    } finally {
      closeHippoDb(db);
    }

    const res = await fetch(`${handle.url}/v1/auth/keys`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${alphaPlaintext}`,
      },
      body: JSON.stringify({ tenantId: 'bravo', label: 'should-be-alpha' }),
    });
    expect(res.status).toBe(200);
    // SAFETY: POST /v1/auth/keys returns AuthCreateResult {keyId, plaintext,
    // tenantId, role} verbatim via sendJson (src/api/index.ts authCreate + the
    // /v1/auth/keys route in src/server.ts).
    const body = (await res.json()) as { keyId: string; plaintext: string; tenantId: string };
    expect(body.tenantId).toBe('alpha');
    expect(body.keyId).toMatch(/^hk_/);

    const db2 = openHippoDb(home);
    try {
      const row = queryRow<{ tenant_id: string }>(db2, `SELECT tenant_id FROM api_keys WHERE key_id = ?`, body.keyId);
      expect(row!.tenant_id).toBe('alpha');
    } finally {
      closeHippoDb(db2);
    }
  });
});
