import { describe, it, expect } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import { queryAuditEvents } from '../src/store/audit.js';
import { runCli as runCliEntry } from '../src/cli.js';
import { runInProcess } from './_helpers/run-in-process.js';
import { makeStore } from './_helpers/make-root.js';

// A3: `hippo forget` on a raw (append-only) memory must not dead-end with a
// misleading "Memory not found" — it reports the append-only nature and points
// at `--archive`, which routes to the sanctioned archiveRaw path.

const savedCwd = process.cwd();

// Column list copied from raw-archive.test.ts — a minimal raw row. tenant_id is
// omitted; the column defaults to 'default', matching the CLI's default tenant.
const RAW_COLS =
  'id, created, last_retrieved, retrieval_count, strength, half_life_days, ' +
  'layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, ' +
  'pinned, confidence, content, kind';

// Mirrors the old spawned helper: stdout alone on success, stdout and stderr together on failure.
async function runCli(cwd: string, ...args: string[]): Promise<{ out: string; status: number }> {
  process.chdir(cwd);
  try {
    const res = await runInProcess(() => runCliEntry(['node', 'hippo', ...args]));
    return { out: res.status === 0 ? res.stdout : res.stdout + res.stderr, status: res.status };
  } finally {
    process.chdir(savedCwd);
  }
}

function makeWorkspaceWithRaw(rawId: string, kind = 'raw'): string {
  const { base: home, root: hippoRoot } = makeStore('forget');
  const db = openHippoDb(hippoRoot);
  try {
    db.prepare(
      `INSERT INTO memories (${RAW_COLS}) VALUES ` +
      `(?, '2026-01-01', '2026-01-01', 0, 1.0, 7, 'episodic', '[]', 'neutral', ` +
      `0.5, 'connector', '[]', 0, 'observed', 'connector raw content', ?)`,
    ).run(rawId, kind);
  } finally {
    closeHippoDb(db);
  }
  return home;
}

function hasRow(home: string, id: string): boolean {
  const db = openHippoDb(join(home, '.hippo'));
  try {
    return db.prepare('SELECT id FROM memories WHERE id = ?').get(id) !== undefined;
  } finally {
    closeHippoDb(db);
  }
}

describe('cli forget: raw memory archive', () => {
  it('reports append-only and points at --archive when forgetting a raw memory', async () => {
    const home = makeWorkspaceWithRaw('mem_rawa3a');
    try {
      const run = await runCli(home, 'forget', 'mem_rawa3a');
      expect(run.status).not.toBe(0);
      expect(run.out).toMatch(/append-only/i);
      expect(run.out).toMatch(/--archive/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('--archive --reason archives the raw memory and emits an archive_raw audit', async () => {
    const home = makeWorkspaceWithRaw('mem_rawa3b');
    try {
      const run = await runCli(home, 'forget', 'mem_rawa3b', '--archive', '--reason', 'A3 test cleanup');
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
  });

  it('--archive without --reason errors clearly', async () => {
    const home = makeWorkspaceWithRaw('mem_rawa3c');
    try {
      const run = await runCli(home, 'forget', 'mem_rawa3c', '--archive');
      expect(run.status).not.toBe(0);
      expect(run.out).toMatch(/--reason/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('still reports "not found" for a genuinely missing id', async () => {
    const home = makeWorkspaceWithRaw('mem_rawa3d');
    try {
      const run = await runCli(home, 'forget', 'mem_definitely_missing');
      expect(run.status).not.toBe(0);
      expect(run.out).toMatch(/not found/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('cli forget --dry-run', () => {
  it('refuses a raw memory the same way the real run does, and keeps it', async () => {
    const home = makeWorkspaceWithRaw('mem_rawdry1');
    try {
      const run = await runCli(home, 'forget', 'mem_rawdry1', '--dry-run');
      expect(run.status).not.toBe(0);
      expect(run.out).toMatch(/append-only/i);
      expect(hasRow(home, 'mem_rawdry1')).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('previews an archive without archiving or auditing', async () => {
    const home = makeWorkspaceWithRaw('mem_rawdry2');
    try {
      const run = await runCli(home, 'forget', 'mem_rawdry2', '--archive', '--reason', 'preview', '--dry-run');
      expect(run.status, run.out).toBe(0);
      expect(run.out).toMatch(/Would archive mem_rawdry2/);
      expect(hasRow(home, 'mem_rawdry2')).toBe(true);
      const db = openHippoDb(join(home, '.hippo'));
      try {
        expect(queryAuditEvents(db, { tenantId: 'default', op: 'archive_raw', limit: 10 })).toHaveLength(0);
      } finally {
        closeHippoDb(db);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('previews a plain forget and keeps the row; a missing id is still not found', async () => {
    const home = makeWorkspaceWithRaw('mem_plaindry', 'distilled');
    try {
      const run = await runCli(home, 'forget', 'mem_plaindry', '--dry-run');
      expect(run.status, run.out).toBe(0);
      expect(run.out).toMatch(/Would forget mem_plaindry/);
      expect(hasRow(home, 'mem_plaindry')).toBe(true);
      const missing = await runCli(home, 'forget', 'mem_definitely_missing', '--dry-run');
      expect(missing.status).not.toBe(0);
      expect(missing.out).toMatch(/not found/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
