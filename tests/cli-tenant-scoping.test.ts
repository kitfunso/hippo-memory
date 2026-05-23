/**
 * v1.11.0 tenant-isolation residue: CLI tenant-scoping via HIPPO_TENANT.
 *
 * Spawns `hippo trace <id>` under different HIPPO_TENANT values and asserts
 * cross-tenant memories are not found. Covers both the local-store read
 * (cmdTrace at cli.ts:1799) and the cross-store global path (cli.ts:1803 + the
 * parent walk at cli.ts:1829). The cross-store case is the deliberate
 * behaviour change documented in the plan's Risks section: a memory promoted
 * to global under tenant_a returns "not found" when traced under
 * HIPPO_TENANT=tenant_b.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initStore, writeEntry } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createMemory } from '../src/memory.js';

const REPO_ROOT = join(__dirname, '..');
const CLI_PATH = join(REPO_ROOT, 'dist', 'cli.js');

function runCli(
  cwd: string,
  env: NodeJS.ProcessEnv,
  ...args: string[]
): { out: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { out: stdout, status: 0 };
  } catch (e) {
    const err = e as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      status?: number;
    };
    const stdout =
      typeof err.stdout === 'string'
        ? err.stdout
        : (err.stdout?.toString('utf8') ?? '');
    const stderr =
      typeof err.stderr === 'string'
        ? err.stderr
        : (err.stderr?.toString('utf8') ?? '');
    return { out: stdout + stderr, status: err.status ?? 1 };
  }
}

describe('CLI tenant-scoping (v1.11.0 residue)', () => {
  let home: string;
  let hippoRoot: string;
  let globalRoot: string;
  let envBase: NodeJS.ProcessEnv;

  beforeAll(() => {
    if (!existsSync(CLI_PATH) || !statSync(CLI_PATH).isFile()) {
      throw new Error(
        `dist/cli.js not found at ${CLI_PATH}. Run \`npm run build\` first.`,
      );
    }
  });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hippo-cli-tenant-'));
    hippoRoot = join(home, '.hippo');
    globalRoot = join(home, '.hippo-global');
    mkdirSync(hippoRoot, { recursive: true });
    mkdirSync(globalRoot, { recursive: true });
    initStore(hippoRoot);
    initStore(globalRoot);
    // Isolate the spawned CLI's global store from the developer's real
    // ~/.hippo by pointing HIPPO_HOME at a per-test temp.
    envBase = { ...process.env, HIPPO_HOME: globalRoot };
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('cmdTrace local store: HIPPO_TENANT=tenant_b hides a tenant_a memory', () => {
    const a = createMemory('A content (local)', {
      tenantId: 'tenant_a',
      tags: ['x'],
    });
    const b = createMemory('B content (local)', {
      tenantId: 'tenant_b',
      tags: ['x'],
    });
    writeEntry(hippoRoot, a);
    writeEntry(hippoRoot, b);

    // Under HIPPO_TENANT=tenant_b, tracing tenant_a's memory returns "not found".
    const aTrace = runCli(
      home,
      { ...envBase, HIPPO_TENANT: 'tenant_b' },
      'trace',
      a.id,
    );
    expect(aTrace.status).not.toBe(0);
    expect(aTrace.out).toMatch(/not found/i);

    // Tracing tenant_b's own memory under HIPPO_TENANT=tenant_b still works.
    const bTrace = runCli(
      home,
      { ...envBase, HIPPO_TENANT: 'tenant_b' },
      'trace',
      b.id,
    );
    expect(bTrace.status, bTrace.out).toBe(0);
    expect(bTrace.out).toMatch(/B content/);
  }, 30_000);

  it('cmdTrace global store: HIPPO_TENANT=tenant_b hides a tenant_a-promoted global memory', () => {
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
    const trace = runCli(
      home,
      { ...envBase, HIPPO_TENANT: 'tenant_b' },
      'trace',
      'g_taPromoted',
    );
    expect(trace.status).not.toBe(0);
    expect(trace.out).toMatch(/not found/i);
  }, 30_000);
});
