// A failed token-ledger write never fails the recall that produced the text, but it is logged instead of swallowed.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import { adminActor, recordTokens } from '../src/api/index.js';
import { handleMcpRequest } from '../src/mcp/server.js';
import { bookTokenUse } from '../src/api/ledger-db.js';
import { promptHookContext } from '../src/api/prompt-hook.js';
import { resetLogOnce } from '../src/util/log.js';
import { createMemory } from './_helpers/default-half-life-memory.js';

let root: string;
let stderrSpy: MockInstance<typeof process.stderr.write>;
const savedHome = process.env.HIPPO_HOME;
const savedLevel = process.env.HIPPO_LOG;
const PROJECT = { name: 'p', legacyName: 'p' };

function skippedLines(): string[] {
  return stderrSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('token ledger row skipped'));
}

function pinNote(store: string): void {
  writeEntry(store, { ...createMemory('the deploy window opens on Tuesdays'), pinned: true, origin_project: 'p' });
}

function ledgerLines(): string[] {
  return stderrSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('token ledger write failed'));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-ledger-fail-'));
  initStore(root);
  const db = openHippoDb(root);
  db.exec('DROP TABLE token_ledger');
  closeHippoDb(db);
  // No global store, so the hook reads and writes this one alone.
  process.env.HIPPO_HOME = path.join(root, 'no-global');
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  resetLogOnce();
});

afterEach(() => {
  stderrSpy.mockRestore();
  if (savedHome === undefined) delete process.env.HIPPO_HOME;
  else process.env.HIPPO_HOME = savedHome;
  if (savedLevel === undefined) delete process.env.HIPPO_LOG;
  else process.env.HIPPO_LOG = savedLevel;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('token ledger write failures', () => {
  it('api.recordTokens warns once and does not throw', async () => {
    const ctx = { hippoRoot: root, tenantId: 'default', actor: adminActor('test') };
    await expect(recordTokens(ctx, 'http_recall', { items: 1, tokens: 10 })).resolves.toBeUndefined();
    await recordTokens(ctx, 'http_recall', { items: 1, tokens: 10 });
    const lines = ledgerLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[hippo\] warn: .*no such table: token_ledger/);
  });

  it('an MCP recall still answers and the ledger failure is warned', async () => {
    writeEntry(root, createMemory('ledger probe note about deploys'));
    const res = await handleMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hippo_recall', arguments: { query: 'deploys' } } },
      { hippoRoot: root, tenantId: 'default', actor: 'mcp' },
    );
    expect(res?.error).toBeUndefined();
    expect(JSON.stringify(res?.result)).toContain('ledger probe note');
    expect(ledgerLines()).toHaveLength(1);
  });

  it('the prompt hook prints its block and warns with the error class when its inject row is refused', async () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-ledger-refused-'));
    try {
      initStore(store);
      pinNote(store);
      const db = openHippoDb(store);
      // Reads still work, so only the hook's own insert can fail.
      db.exec("CREATE TRIGGER refuse_ledger BEFORE INSERT ON token_ledger BEGIN SELECT RAISE(ABORT, 'ledger insert refused'); END");
      closeHippoDb(db);
      const out = await promptHookContext({ hippoRoot: store, tenantId: 'default', actor: adminActor('test') }, { sessionId: 's-refused', project: PROJECT });
      expect(out.stdout).toContain('the deploy window opens on Tuesdays');
      const lines = skippedLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^\[hippo\] warn: token ledger row skipped: ledger insert refused ts=\S+ errorClass=\w+ stack=\S/);
    } finally {
      fs.rmSync(store, { recursive: true, force: true });
    }
  });

  it('a store with no ledger table is an expected skip: nothing at the default level, one debug line with no stack, and the hook prints its block', async () => {
    pinNote(root);
    const hook = (sessionId: string) => promptHookContext({ hippoRoot: root, tenantId: 'default', actor: adminActor('test') }, { sessionId, project: PROJECT });
    expect((await hook('s-dropped-1')).stdout).toContain('the deploy window opens on Tuesdays');
    expect(skippedLines()).toEqual([]);

    process.env.HIPPO_LOG = 'debug';
    expect((await hook('s-dropped-2')).stdout).toContain('the deploy window opens on Tuesdays');
    const lines = skippedLines();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^\[hippo\] debug: token ledger row skipped: no such table: token_ledger ts=\S+\n$/);
    }
  });

  it('a hippo.db that is not a database is an expected skip: nothing at the default level, one debug line with no stack', () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-ledger-notadb-'));
    const write = (): void => {
      bookTokenUse(store, { tenantId: 'default', surface: 'hook', event: 'inject', items: 1, tokens: 40 });
    };
    try {
      initStore(store);
      fs.writeFileSync(path.join(store, 'hippo.db'), 'not a valid sqlite database file, just garbage bytes 0000000');
      for (const suffix of ['-wal', '-shm']) fs.rmSync(path.join(store, `hippo.db${suffix}`), { force: true });
      write();
      expect(stderrSpy.mock.calls).toEqual([]);

      process.env.HIPPO_LOG = 'debug';
      write();
      expect(skippedLines()).toHaveLength(1);
      expect(skippedLines()[0]).toMatch(/^\[hippo\] debug: token ledger row skipped: file is not a database ts=\S+\n$/);
    } finally {
      fs.rmSync(store, { recursive: true, force: true });
    }
  });
});
