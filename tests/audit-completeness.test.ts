import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { queryAuditEvents } from '../src/audit.js';

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
