import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { queryAuditEvents } from '../src/audit.js';
import { archiveRawMemory } from '../src/raw-archive.js';

const repoRoot = resolve(__dirname, '..');
const cli = resolve(repoRoot, 'dist', 'cli.js');

describe('audit log captures every mutation', () => {
  it('remember + recall both logged via CLI flow', () => {
    if (!existsSync(cli)) {
      throw new Error(`dist/cli.js not found at ${cli} — run \`npm run build\` first`);
    }
    // HIPPO_HOME is the global root in --global mode (see getGlobalRoot in
    // src/shared.ts). Same pattern as tests/recall-why-envelope.test.ts.
    const home = mkdtempSync(join(tmpdir(), 'hippo-audit-cli-'));
    const env = { ...process.env, HIPPO_HOME: home };
    try {
      execSync(`node "${cli}" init`, { env, cwd: home });
      execSync(`node "${cli}" init --global`, { env, cwd: home });
      execSync(`node "${cli}" remember "audit-canary-99 distinguishing token" --global`, { env, cwd: home });
      execSync(`node "${cli}" recall "audit-canary-99" --global`, { env, cwd: home });

      const db = openHippoDb(home);
      try {
        const events = queryAuditEvents(db, { tenantId: 'default' });
        const ops = events.map((e) => e.op);
        expect(ops).toContain('remember');
        expect(ops).toContain('recall');
      } finally {
        closeHippoDb(db);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('promote logs a promote event on the global store', () => {
    if (!existsSync(cli)) {
      throw new Error(`dist/cli.js not found at ${cli} — run \`npm run build\` first`);
    }
    const home = mkdtempSync(join(tmpdir(), 'hippo-audit-promote-'));
    const env = { ...process.env, HIPPO_HOME: home };
    try {
      execSync(`node "${cli}" init`, { env, cwd: home });
      execSync(`node "${cli}" init --global`, { env, cwd: home });
      execSync(
        `node "${cli}" remember "audit-promote-canary-55 distinguishing token"`,
        { env, cwd: home },
      );
      const localRoot = join(home, '.hippo');
      const dbLocal = openHippoDb(localRoot);
      let localId: string | undefined;
      try {
        const row = dbLocal
          .prepare(`SELECT id FROM memories WHERE content LIKE '%audit-promote-canary-55%' LIMIT 1`)
          .get() as { id?: string } | undefined;
        localId = row?.id;
      } finally {
        closeHippoDb(dbLocal);
      }
      expect(localId, 'expected to find local row id').toBeTruthy();

      execSync(`node "${cli}" promote ${localId}`, { env, cwd: home });

      // promote audit lands on the global store (HIPPO_HOME).
      const dbGlobal = openHippoDb(home);
      try {
        const events = queryAuditEvents(dbGlobal, { tenantId: 'default', op: 'promote' });
        expect(events.length).toBeGreaterThan(0);
        const meta = events[0]!.metadata as { sourceId?: string };
        expect(meta.sourceId).toBe(localId);
      } finally {
        closeHippoDb(dbGlobal);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('supersede logs a supersede event with newId metadata', () => {
    if (!existsSync(cli)) {
      throw new Error(`dist/cli.js not found at ${cli} — run \`npm run build\` first`);
    }
    const home = mkdtempSync(join(tmpdir(), 'hippo-audit-supersede-'));
    const env = { ...process.env, HIPPO_HOME: home };
    try {
      execSync(`node "${cli}" init`, { env, cwd: home });
      execSync(
        `node "${cli}" remember "audit-supersede-canary-33 old content"`,
        { env, cwd: home },
      );
      const localRoot = join(home, '.hippo');
      const db = openHippoDb(localRoot);
      let oldId: string | undefined;
      try {
        const row = db
          .prepare(`SELECT id FROM memories WHERE content LIKE '%audit-supersede-canary-33%' LIMIT 1`)
          .get() as { id?: string } | undefined;
        oldId = row?.id;
      } finally {
        closeHippoDb(db);
      }
      expect(oldId, 'expected to find old row id').toBeTruthy();

      execSync(
        `node "${cli}" supersede ${oldId} "audit-supersede-canary-33 new content"`,
        { env, cwd: home },
      );

      const db2 = openHippoDb(localRoot);
      try {
        const events = queryAuditEvents(db2, { tenantId: 'default', op: 'supersede' });
        const match = events.find((e) => e.targetId === oldId);
        expect(match, `expected supersede event for ${oldId}`).toBeTruthy();
        const meta = match!.metadata as { newId?: string };
        expect(meta.newId).toBeTruthy();
        expect(meta.newId).not.toBe(oldId);
      } finally {
        closeHippoDb(db2);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('archiveRawMemory logs an archive_raw event with row tenant_id', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-audit-archive-'));
    const db = openHippoDb(home);
    try {
      // Insert a raw row directly with a non-default tenant to confirm M3:
      // archive_raw audit must use the row's tenant_id, not env.
      db.prepare(
        `INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content, kind, tenant_id) VALUES ('raw1','2026-01-01','2026-01-01',0,1.0,7,'episodic','[]','neutral',0.5,'test','[]',0,'observed','sensitive','raw','tenant_x')`,
      ).run();

      archiveRawMemory(db, 'raw1', { reason: 'GDPR', who: 'user:42' });

      const events = queryAuditEvents(db, { tenantId: 'tenant_x', op: 'archive_raw' });
      expect(events.length).toBe(1);
      expect(events[0]!.targetId).toBe('raw1');
      expect(events[0]!.actor).toBe('user:42');
      const meta = events[0]!.metadata as { reason?: string };
      expect(meta.reason).toBe('GDPR');

      // And nothing leaks into the default tenant.
      const defaultEvents = queryAuditEvents(db, { tenantId: 'default', op: 'archive_raw' });
      expect(defaultEvents.length).toBe(0);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('forget logs a forget event', () => {
    if (!existsSync(cli)) {
      throw new Error(`dist/cli.js not found at ${cli} — run \`npm run build\` first`);
    }
    const home = mkdtempSync(join(tmpdir(), 'hippo-audit-forget-'));
    const env = { ...process.env, HIPPO_HOME: home };
    try {
      // Local store flow (cmdForget is local-store only). Remember + forget
      // both target the local .hippo dir under cwd=home.
      execSync(`node "${cli}" init`, { env, cwd: home });
      execSync(
        `node "${cli}" remember "audit-forget-canary-77 distinguishing token"`,
        { env, cwd: home },
      );
      const localRoot = join(home, '.hippo');
      const db = openHippoDb(localRoot);
      let rememberedId: string | undefined;
      try {
        const row = db
          .prepare(`SELECT id FROM memories WHERE content LIKE '%audit-forget-canary-77%' LIMIT 1`)
          .get() as { id?: string } | undefined;
        rememberedId = row?.id;
      } finally {
        closeHippoDb(db);
      }
      expect(rememberedId, 'expected to find row id in local db').toBeTruthy();

      execSync(`node "${cli}" forget ${rememberedId}`, { env, cwd: home });

      const db2 = openHippoDb(localRoot);
      try {
        const events = queryAuditEvents(db2, { tenantId: 'default', op: 'forget' });
        const ids = events.map((e) => e.targetId);
        expect(ids).toContain(rememberedId);
      } finally {
        closeHippoDb(db2);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
