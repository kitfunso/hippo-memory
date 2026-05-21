import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { queryAuditEvents } from '../src/audit.js';

// A3: `hippo forget` on a raw (append-only) memory must not dead-end with a
// misleading "Memory not found" — it reports the append-only nature and points
// at `--archive`, which routes to the sanctioned archiveRaw path.

const REPO_ROOT = join(__dirname, '..');
const CLI_PATH = join(REPO_ROOT, 'dist', 'cli.js');

// Column list copied from raw-archive.test.ts — a minimal raw row. tenant_id is
// omitted; the column defaults to 'default', matching the CLI's default tenant.
const RAW_COLS =
  'id, created, last_retrieved, retrieval_count, strength, half_life_days, ' +
  'layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, ' +
  'pinned, confidence, content, kind';

function runCli(cwd: string, ...args: string[]): { out: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      cwd, env: { ...process.env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { out: stdout, status: 0 };
  } catch (e) {
    const err = e as { stdout?: string | Buffer; stderr?: string | Buffer; status?: number };
    const stdout = typeof err.stdout === 'string' ? err.stdout : (err.stdout?.toString('utf8') ?? '');
    const stderr = typeof err.stderr === 'string' ? err.stderr : (err.stderr?.toString('utf8') ?? '');
    return { out: stdout + stderr, status: err.status ?? 1 };
  }
}

function makeWorkspaceWithRaw(rawId: string): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-forget-'));
  const hippoRoot = join(home, '.hippo');
  mkdirSync(hippoRoot, { recursive: true });
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    db.prepare(
      `INSERT INTO memories (${RAW_COLS}) VALUES ` +
      `(?, '2026-01-01', '2026-01-01', 0, 1.0, 7, 'episodic', '[]', 'neutral', ` +
      `0.5, 'connector', '[]', 0, 'observed', 'connector raw content', ?)`,
    ).run(rawId, 'raw');
  } finally {
    closeHippoDb(db);
  }
  return home;
}

describe('cli forget — raw memory archive (A3)', () => {
  beforeAll(() => {
    if (!existsSync(CLI_PATH) || !statSync(CLI_PATH).isFile()) {
      throw new Error(`dist/cli.js not found at ${CLI_PATH}. Run \`npm run build\` first.`);
    }
  });

  it('reports append-only and points at --archive when forgetting a raw memory', () => {
    const home = makeWorkspaceWithRaw('mem_rawa3a');
    try {
      const run = runCli(home, 'forget', 'mem_rawa3a');
      expect(run.status).not.toBe(0);
      expect(run.out).toMatch(/append-only/i);
      expect(run.out).toMatch(/--archive/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  it('--archive --reason archives the raw memory and emits an archive_raw audit', () => {
    const home = makeWorkspaceWithRaw('mem_rawa3b');
    try {
      const run = runCli(home, 'forget', 'mem_rawa3b', '--archive', '--reason', 'A3 test cleanup');
      expect(run.status, run.out).toBe(0);
      expect(run.out).toMatch(/Archived mem_rawa3b/);
      const db = openHippoDb(join(home, '.hippo'));
      try {
        expect(db.prepare(`SELECT id FROM memories WHERE id = 'mem_rawa3b'`).get()).toBeUndefined();
        const events = queryAuditEvents(db, { tenantId: 'default', op: 'archive_raw', limit: 10 });
        expect(events.length).toBeGreaterThan(0);
      } finally {
        closeHippoDb(db);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  it('--archive without --reason errors clearly', () => {
    const home = makeWorkspaceWithRaw('mem_rawa3c');
    try {
      const run = runCli(home, 'forget', 'mem_rawa3c', '--archive');
      expect(run.status).not.toBe(0);
      expect(run.out).toMatch(/--reason/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  it('still reports "not found" for a genuinely missing id', () => {
    const home = makeWorkspaceWithRaw('mem_rawa3d');
    try {
      const run = runCli(home, 'forget', 'mem_definitely_missing');
      expect(run.status).not.toBe(0);
      expect(run.out).toMatch(/not found/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);
});
