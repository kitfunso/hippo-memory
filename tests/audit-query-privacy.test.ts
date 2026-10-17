import type { FullContext } from './_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initStore } from '../src/store/open.js';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import { auditQueryFields } from '../src/store/audit.js';
import { getContext, retrieve, remember } from '../src/api/index.js';
import { handleMcpRequest, type McpContext } from '../src/mcp/server.js';
import { serve, type ServerHandle } from '../src/server.js';
import { apiCtx } from './_helpers/api-ctx.js';
import { sqliteStore } from '../src/store/sqlite/store.js';
import { makeRoot } from './_helpers/make-root.js';

beforeEach(() => {
  vi.stubEnv('HIPPO_ALLOW_KEYLESS_LOCAL', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const HIPPO_BIN = join(process.cwd(), 'bin', 'hippo.js');
const CANARY = 'zqcanaryneedle';
const QUERY = `${CANARY} private customer question`;

let home: string;
let localRoot: string;
let globalRoot: string;
let ctx: FullContext;

interface RecallMetadata {
  query?: string;
  query_hash?: string;
  query_length?: number;
  mode?: string;
}

interface AuditRow {
  op: string;
  metadata: RecallMetadata;
  text: string;
}

function auditRows(root: string): AuditRow[] {
  if (!existsSync(join(root, 'hippo.db'))) return [];
  const db = openHippoDb(root);
  try {
    // SAFETY: SELECT projects only the op and metadata_json TEXT columns.
    const rows = db.prepare('SELECT op, metadata_json FROM audit_log').all() as Array<{ op: string; metadata_json: string }>;
    // SAFETY: metadata_json is written by appendAuditEvent via JSON.stringify.
    return rows.map((r) => ({ op: r.op, metadata: JSON.parse(r.metadata_json) as RecallMetadata, text: r.metadata_json }));
  } finally {
    closeHippoDb(db);
  }
}

function expectHashedOnly(row: AuditRow, query: string): void {
  expect(row.metadata).not.toHaveProperty('query');
  expect(row.metadata.query_length).toBe(query.length);
  expect(row.metadata.query_hash).toBe(auditQueryFields(query).query_hash);
}

function expectNoCanary(): void {
  const rows = [...auditRows(localRoot), ...auditRows(globalRoot)];
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(row.text).not.toContain(CANARY);
}

beforeEach(async () => {
  home = makeRoot('audit-privacy', { init: false });
  mkdirSync(join(home, '.hippo'), { recursive: true });
  localRoot = join(home, '.hippo');
  globalRoot = join(home, 'global-hippo');
  vi.stubEnv('HIPPO_HOME', globalRoot);
  initStore(localRoot);
  ctx = apiCtx(localRoot, 'default', { subject: 'test', role: 'admin' });
  await remember(ctx, { content: `${CANARY} stored memory body` });
});

describe('auditQueryFields', () => {
  it('returns a 16-char sha256 prefix and the query length', () => {
    const f = auditQueryFields('abc');
    expect(f.query_hash).toBe('ba7816bf8f01cfea');
    expect(f.query_length).toBe(3);
  });
});

describe('recall audits store a query hash, never the text', () => {
  it('context recall row has no query key', async () => {
    await getContext(ctx, { q: QUERY, crossProject: true });
    const rows = auditRows(localRoot).filter((r) => r.op === 'recall' && r.metadata.mode === 'context');
    expect(rows).toHaveLength(1);
    expectHashedOnly(rows[0], QUERY);
  });

  it('context recall writes the same hashed row into the global store it reached', async () => {
    initStore(globalRoot);
    await getContext(apiCtx(localRoot, 'default', { subject: 'test', role: 'admin' }), { q: QUERY, crossProject: true });
    const [local, global] = [localRoot, globalRoot].map((root) =>
      auditRows(root).filter((r) => r.op === 'recall' && r.metadata.mode === 'context'));
    expect(global).toHaveLength(1);
    expectHashedOnly(global[0], QUERY);
    expect(global[0].metadata).toEqual(local[0].metadata);
  });

  it('CLI recall row has no query key', () => {
    execFileSync('node', [HIPPO_BIN, 'recall', QUERY], {
      cwd: home,
      env: { ...process.env, HIPPO_HOME: globalRoot, HIPPO_SKIP_AUTO_INTEGRATIONS: '1' },
      encoding: 'utf-8',
    });
    const rows = auditRows(localRoot).filter((r) => r.op === 'recall');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expectHashedOnly(row, QUERY);
  });
});

describe('census: a canary query reaches no audit metadata value', () => {
  it('context, CLI, MCP and HTTP recall', async () => {
    await getContext(ctx, { q: QUERY, crossProject: true });
    await retrieve(ctx, { query: QUERY });
    execFileSync('node', [HIPPO_BIN, 'recall', QUERY], {
      cwd: home,
      env: { ...process.env, HIPPO_HOME: globalRoot, HIPPO_SKIP_AUTO_INTEGRATIONS: '1' },
      encoding: 'utf-8',
    });
    const mcpCtx: McpContext = { hippoRoot: localRoot, tenantId: 'default', actor: 'mcp', role: 'admin', hostAdmin: true , store: sqliteStore(localRoot) };
    await handleMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hippo_recall', arguments: { query: QUERY } } },
      mcpCtx,
    );
    const handle: ServerHandle = await serve({ hippoRoot: localRoot, port: 0 });
    try {
      const res = await fetch(`${handle.url}/v1/memories?q=${encodeURIComponent(QUERY)}`);
      expect(res.status).toBe(200);
    } finally {
      await handle.stop();
    }
    expectNoCanary();
    const ops = new Set(auditRows(localRoot).map((r) => r.op));
    expect(ops.has('recall')).toBe(true);
    expect(auditRows(localRoot).some((r) => r.metadata.mode === 'context')).toBe(true);
    expect(ops.has('recall_anchor_skipped_no_session')).toBe(true);
  });
});
