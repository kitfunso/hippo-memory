// The GitHub rate-limit wait is bounded, a failed rollback cannot hide the original error, and four silent fallbacks now log.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '../src/api/index.js';
import { backfillRepo } from '../src/connectors/github/backfill.js';
import type { GitHubFetcher } from '../src/connectors/github/octokit-client.js';
import { closeHippoDb, openHippoDb, withReadSnapshot, withWriteScope, type DatabaseSyncLike } from '../src/db/index.js';
import { resolveCodexSessionTranscript } from '../src/hooks/codex-session.js';
import { importChatGPT, importClaude } from '../src/importers/sources.js';
import { detectServer } from '../src/server/server-detect.js';
import { makeRoot } from './_helpers/make-root.js';

let root: string;
let stderr: string;

beforeEach(() => {
  root = makeRoot('r2');
  stderr = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('GitHub backfill rate-limit bound', () => {
  const ctx = (): Context => ({ hippoRoot: root, tenantId: 'default', actor: { subject: 'connector:github', role: 'admin' } });

  it('stops after five attempts and names the reset time', async () => {
    let calls = 0;
    const fetcher: GitHubFetcher = async () => {
      calls++;
      return { items: [], next: null, rateLimit: { sleepSeconds: 1, reason: 'secondary' } };
    };
    const sleeps: number[] = [];
    await expect(
      backfillRepo(ctx(), { repoFullName: 'acme/demo', fetcher, token: 't', sleepMs: async (ms) => { sleeps.push(ms); } }),
    ).rejects.toThrow(/still active after 5 attempts.*resets at \d{4}-\d{2}-\d{2}T/);
    expect(calls).toBe(5);
    expect(sleeps).toEqual([1000, 1000, 1000, 1000]);
  });

  it('refuses a single wait longer than the total cap without sleeping', async () => {
    const fetcher: GitHubFetcher = async () => ({ items: [], next: null, rateLimit: { sleepSeconds: 3600, reason: 'primary' } });
    const sleeps: number[] = [];
    await expect(
      backfillRepo(ctx(), { repoFullName: 'acme/demo', fetcher, token: 't', sleepMs: async (ms) => { sleeps.push(ms); } }),
    ).rejects.toThrow(/resets at/);
    expect(sleeps).toEqual([]);
  });
});

describe('write scope rollback failure', () => {
  // Real store; only the named statement is made to fail, so the scope is still open when the undo runs.
  function failingOn(db: DatabaseSyncLike, failing: string, message: string): DatabaseSyncLike {
    return {
      exec: (sql) => {
        if (sql === failing) throw new Error(message);
        db.exec(sql);
      },
      prepare: (sql) => db.prepare(sql),
      close: () => db.close(),
      get isTransaction() { return db.isTransaction; },
    };
  }

  it('keeps throwing the original error and logs the rollback failure at error', () => {
    const db = openHippoDb(root);
    try {
      const wrapped = failingOn(db, 'ROLLBACK', 'disk I/O error on rollback');
      expect(() => withWriteScope(wrapped, 'r2', () => { throw new Error('original failure'); })).toThrow('original failure');
      expect(stderr).toMatch(/error: rollback of write scope r2 failed: disk I\/O error on rollback/);
      db.exec('ROLLBACK');
    } finally {
      closeHippoDb(db);
    }
  });

  it('logs a read snapshot that cannot end and still throws the original error', () => {
    const db = openHippoDb(root);
    try {
      const wrapped = failingOn(db, 'COMMIT', 'commit refused');
      expect(() => withReadSnapshot(wrapped, () => { throw new Error('read failed'); })).toThrow('read failed');
      expect(stderr).toMatch(/error: ending read snapshot failed: commit refused/);
      db.exec('ROLLBACK');
    } finally {
      closeHippoDb(db);
    }
  });

  it('stays quiet when SQLite already unwound the scope', () => {
    const db = openHippoDb(root);
    try {
      expect(() => withWriteScope(db, 'r2', () => { db.exec('ROLLBACK'); throw new Error('boom'); })).toThrow('boom');
      expect(stderr).toBe('');
    } finally {
      closeHippoDb(db);
    }
  });
});

describe('logged fallbacks', () => {
  it('warns with the path and parse error when a ChatGPT .json file is not JSON, then reads plain text', () => {
    const file = path.join(root, 'memories.json');
    fs.writeFileSync(file, '{ not json at all', 'utf8');
    importChatGPT(file, { hippoRoot: root, dryRun: true });
    expect(stderr).toContain(`warn: import: ${file} is not valid JSON`);
  });

  it('warns the same way for a Claude .json file, then reads markdown', () => {
    const file = path.join(root, 'claude.json');
    fs.writeFileSync(file, '[1, 2,', 'utf8');
    importClaude(file, { hippoRoot: root, dryRun: true });
    expect(stderr).toContain(`warn: import: ${file} is not valid JSON`);
  });

  it('warns on a malformed codex history line', () => {
    const history = path.join(root, 'history.jsonl');
    fs.writeFileSync(history, 'not json\n{"session_id":"abc"}\n', 'utf8');
    const found = resolveCodexSessionTranscript({
      codexHome: path.join(root, 'codex'),
      historyPath: history,
      startOffsetBytes: 0,
      startedAtMs: Date.now(),
    });
    expect(found).toBeNull();
    expect(stderr).toContain(`warn: codex history ${history}: skipped a malformed JSONL line`);
  });

  it('warns and removes a pidfile that is not JSON', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-r2-pid-'));
    try {
      const pidfile = path.join(home, 'server.pid');
      fs.writeFileSync(pidfile, '{broken');
      expect(await detectServer(home)).toBeNull();
      expect(fs.existsSync(pidfile)).toBe(false);
      expect(stderr).toContain(`warn: server pidfile ${pidfile} is unreadable`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
