/**
 * v1.11.0 tenant-isolation residue: CLI tenant-scoping via HIPPO_TENANT.
 *
 * Runs `hippo trace <id>` under different HIPPO_TENANT values and asserts
 * cross-tenant memories are not found. Covers both the local-store read
 * (printTrace at cli.ts:1799) and the cross-store global path (cli.ts:1803 + the
 * parent walk at cli.ts:1829). The cross-store case is the deliberate
 * behaviour change documented in the plan's Risks section: a memory promoted
 * to global under tenant_a returns "not found" when traced under
 * HIPPO_TENANT=tenant_b.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { runCli as runCliEntry } from '../../src/cli.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadEveryTenantEntries, writeEntry } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';

const savedCwd = process.cwd();

interface CliRunResult {
  out: string;
  status: number;
}

// Mirrors the old spawned helper: stdout alone on success, stdout and stderr together on failure.
async function runCli(tenant: string, ...args: string[]): Promise<CliRunResult> {
  vi.stubEnv('HIPPO_TENANT', tenant);
  const res = await runInProcess(() => runCliEntry(['node', 'hippo', ...args]));
  return { out: res.status === 0 ? res.stdout : res.stdout + res.stderr, status: res.status };
}

describe('CLI tenant-scoping', () => {
  let home: string;
  let hippoRoot: string;
  let globalRoot: string;

  beforeEach(() => {
    home = makeRoot('cli-tenant', { init: false });
    hippoRoot = join(home, '.hippo');
    globalRoot = join(home, '.hippo-global');
    mkdirSync(hippoRoot, { recursive: true });
    mkdirSync(globalRoot, { recursive: true });
    initTestStore(hippoRoot);
    initTestStore(globalRoot);
    // Isolate the CLI's global store from the developer's real ~/.hippo by pointing HIPPO_HOME at a per-test temp.
    vi.stubEnv('HIPPO_HOME', globalRoot);
    process.chdir(home);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    vi.unstubAllEnvs();
  });

  it('printTrace local store: HIPPO_TENANT=tenant_b hides a tenant_a memory', async () => {
    const a = createMemory('A content (local)', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      tenantId: 'tenant_a',
      tags: ['x'],
    });
    const b = createMemory('B content (local)', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      tenantId: 'tenant_b',
      tags: ['x'],
    });
    writeEntry(hippoRoot, a);
    writeEntry(hippoRoot, b);

    // Under HIPPO_TENANT=tenant_b, tracing tenant_a's memory returns "not found".
    const aTrace = await runCli('tenant_b', 'trace', a.id);
    expect(aTrace.status).not.toBe(0);
    expect(aTrace.out).toMatch(/not found/i);

    // Tracing tenant_b's own memory under HIPPO_TENANT=tenant_b still works.
    const bTrace = await runCli('tenant_b', 'trace', b.id);
    expect(bTrace.status, bTrace.out).toBe(0);
    expect(bTrace.out).toMatch(/B content/);
  });

  it('printTrace global store: HIPPO_TENANT=tenant_b hides a tenant_a-promoted global memory', async () => {
    // Seed a g_* memory directly into the isolated global store with
    // tenant_id=tenant_a — simulates an entry promoted by another tenant.
    const db = openHippoDb(globalRoot);
    try {
      const cols =
        'id, tenant_id, created, last_retrieved, retrieval_count, strength, ' +
        'half_life_days, layer, tags_json, emotional_valence, schema_fit, ' +
        'source, conflicts_with_json, pinned, confidence, content, kind';
      db.prepare(
        `INSERT INTO memories (${cols}) VALUES ` +
          `(?, ?, '2026-01-01', '2026-01-01', 0, 1.0, 7, 'episodic', '[]', ` +
          `'neutral', 0.5, 'test', '[]', 0, 'observed', ?, 'distilled')`,
      ).run('g_taPromoted', 'tenant_a', 'A content (global)');
    } finally {
      closeHippoDb(db);
    }

    // Under HIPPO_TENANT=tenant_b the cross-tenant global trace returns
    // "not found" — the cross-store tightening behaviour change.
    const trace = await runCli('tenant_b', 'trace', 'g_taPromoted');
    expect(trace.status).not.toBe(0);
    expect(trace.out).toMatch(/not found/i);
  });

  function seed(tenantId: string, content: string): string {
    const entry = createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tenantId, tags: ['x'] });
    writeEntry(hippoRoot, entry);
    return entry.id;
  }

  it('audit --fix under tenant_b deletes only tenant_b rows, with a reason', async () => {
    const aJunk = seed('tenant_a', 'tiny note');
    const bJunk = seed('tenant_b', 'tiny note');
    const res = await runCli('tenant_b', 'audit', '--fix');
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain('Removed 1 error-severity');
    expect(loadEveryTenantEntries(hippoRoot).map((e) => e.id)).toEqual([aJunk]);

    const db = openHippoDb(hippoRoot);
    try {
      const row = db
        .prepare(`SELECT tenant_id, metadata_json FROM audit_log WHERE op = 'forget' AND target_id = ?`)
        .get(bJunk);
      expect(row).toMatchObject({ tenant_id: 'tenant_b', metadata_json: expect.stringContaining('audit --fix: ') });
    } finally {
      closeHippoDb(db);
    }
  });

  it('export under tenant_b leaves out tenant_a rows', async () => {
    seed('tenant_a', 'A content for export');
    seed('tenant_b', 'B content for export');
    const res = await runCli('tenant_b', 'export');
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain('B content for export');
    expect(res.out).not.toContain('A content for export');
  });

  it('supersede under tenant_b writes the successor into tenant_b', async () => {
    const old = seed('tenant_b', 'B original content');
    const res = await runCli('tenant_b', 'supersede', old, 'B replacement content');
    expect(res.status, res.out).toBe(0);
    const successor = loadEveryTenantEntries(hippoRoot).find((e) => e.content === 'B replacement content');
    expect(successor?.tenantId).toBe('tenant_b');
  });
});
