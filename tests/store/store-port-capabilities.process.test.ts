// What a store can do is the groups it sets: audit and learn run on hippo.db's stores, and a store without local files
// gets neither sleep nor an unfenced hippo.db.
import type { Context } from '../../src/api/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  adminActor,
  auditMemoryQuality,
  CLI_LEARN,
  learn,
  auditPrune,
  auditRemoveErrors,
  memoryQualityRepair,
  memoryQualityRepairOnce,
} from '../../src/api/index.js';
import { openHippoDb, closeHippoDb, SqliteBlockedError } from '../../src/db/index.js';
import { handleMcpRequest, type McpResponse } from '../../src/surface/mcp/server.js';
import type { HippoStore } from '../../src/store/index.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { workerSqliteStore } from '../../src/store/sqlite/worker-store.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { Layer } from '../../src/base/memory/memory.js';
import { portOnlyStore } from '../_helpers/port-only-store.js';
import { jsonHeaders, keyFor, newRoot, start, undoAll } from '../_helpers/store-worker-server.js';
import { loadConfig } from '../../src/base/config/config.js';
import { writeEntry, loadAllEntries } from '../_helpers/root-forms.js';
import { processGit } from '../../src/infra/git-runner.js';

afterEach(undoAll);

const NO_EMBEDDINGS = { embeddings: { enabled: false } };

function repoWithOneFix(root: string): string {
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  };
  git('init');
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.com');
  git('commit', '--allow-empty', '-m', 'fix: the pool timeout drops idle sockets after 30s');
  return repo;
}

function rootWithConfig(label: string): string {
  const root = newRoot(label);
  writeFileSync(join(root, 'config.json'), JSON.stringify(NO_EMBEDDINGS));
  return root;
}

const ctxOn = (root: string, store: HippoStore): Context => ({
  tenantId: 'default',
  actor: adminActor('capability-test'),
  store,
  config: loadConfig(root),
});

describe.each([
  ['sqliteStore', sqliteStore],
  ['workerSqliteStore', (root: string) => workerSqliteStore(root)],
] as const)('audit and learn on %s', (_name, make) => {
  it('audit finds and removes an error row, prunes the audit log and repairs; learn writes the lesson', async () => {
    const root = rootWithConfig('capability-sqlite');
    const store = make(root);
    try {
      const ctx = ctxOn(root, store);
      const short = createMemory('tiny');
      const kept = createMemory('the release train leaves every Tuesday at noon');
      for (const entry of [short, kept]) writeEntry(root, entry);

      const audit = await auditMemoryQuality(ctx);
      const errors = audit.issues.filter((issue) => issue.severity === 'error');
      expect(errors.map((issue) => issue.memoryId)).toEqual([short.id]);
      expect(await auditRemoveErrors(ctx, 'audit --fix', errors)).toEqual([short.id]);
      expect((await auditPrune(ctx, { olderThanDays: 30, dryRun: true })).dryRun).toBe(true);
      expect((await memoryQualityRepair(ctx, false)).total).toBe(1);

      const learned = await learn(ctx, {
        repoPath: repoWithOneFix(root),
        days: 7,
        profile: CLI_LEARN,
        git: processGit,
      });
      expect(learned).toMatchObject({ status: 'scanned', added: 1 });
      expect(loadAllEntries(root, 'default').filter((e) => e.source === CLI_LEARN.source)).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it('quality repair sets aside a certain defect, keeps a pinned one by the api protection, then runs once', async () => {
    const root = rootWithConfig('capability-repair');
    const store = make(root);
    try {
      const ctx = ctxOn(root, store);
      const automatic = { source: 'capture', confidence: 'observed', layer: Layer.Episodic } as const;
      const bad = createMemory('Found local migration files to be', automatic);
      const pinned = createMemory('Found local migration files to be', { ...automatic, pinned: true });
      for (const entry of [bad, pinned]) writeEntry(root, entry);

      expect((await memoryQualityRepair(ctx, false)).issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: bad.id, disposition: 'set-aside' }),
          expect.objectContaining({ id: pinned.id, disposition: 'protected', protection: 'pinned' }),
        ]),
      );
      expect((await memoryQualityRepair(ctx, true)).appliedIds).toEqual([bad.id]);
      expect(loadAllEntries(root, 'default').map((e) => e.id)).toEqual([pinned.id]);
      expect(await memoryQualityRepairOnce(ctx)).toMatchObject({ supported: true, appliedIds: [] });
      expect(await memoryQualityRepairOnce(ctx)).toBeNull();
    } finally {
      await store.close();
    }
  });
});

describe('serve() under a store without local files', () => {
  it('POST /v1/sleep answers 501', async () => {
    const root = newRoot('capability-sleep-http');
    const { plaintext } = keyFor(root, 'default');
    const handle = await start(root, portOnlyStore(root));
    const res = await fetch(`${handle.url}/v1/sleep`, {
      method: 'POST',
      headers: jsonHeaders(plaintext),
      body: JSON.stringify({ dry_run: true }),
    });
    expect(res.status).toBe(501);
  });

  it('POST /v1/memories/:id/promote answers 501', async () => {
    const root = newRoot('capability-promote-http');
    const { plaintext } = keyFor(root, 'default');
    const handle = await start(root, portOnlyStore(root));
    const res = await fetch(`${handle.url}/v1/memories/m1/promote`, {
      method: 'POST',
      headers: jsonHeaders(plaintext),
    });
    expect(res.status).toBe(501);
  });

  it('still fences hippo.db inside a request', async () => {
    const root = newRoot('capability-fence');
    const { plaintext } = keyFor(root, 'default');
    const blocked: unknown[] = [];
    const store: HippoStore = {
      ...portOnlyStore(root),
      async findApiKey() {
        try {
          closeHippoDb(openHippoDb(root));
        } catch (err) {
          blocked.push(err);
        }
        return null;
      },
    };
    const handle = await start(root, store);
    const res = await fetch(`${handle.url}/v1/memories?q=x`, { headers: jsonHeaders(plaintext) });
    expect(res.status).toBe(401);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toBeInstanceOf(SqliteBlockedError);
  });
});

describe('MCP hippo_remember', () => {
  it('answers the half-life from the write, with no read back', async () => {
    const root = rootWithConfig('capability-mcp-remember');
    const store = sqliteStore(root);
    const reads = vi.spyOn(store, 'entriesByIds');
    const res: McpResponse | null = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'hippo_remember', arguments: { text: 'the deploy window opens at nine', tag: 'ops' } },
      },
      {
        hippoRoot: root,
        tenantId: 'default',
        actor: 'mcp',
        role: 'admin',
        hostAdmin: true,
        store,
        config: loadConfig(root),
      },
    );
    // SAFETY: a tools/call reply carries result.content[0].text.
    const text = (res?.result as { content: { text: string }[] } | undefined)?.content[0]?.text;
    const [row] = loadAllEntries(root, 'default');
    expect(text).toBe(`Remembered [${row!.id}] (half-life: ${row!.halfLifeDays}d, tags: ops)`);
    expect(reads).not.toHaveBeenCalled();
  });
});
