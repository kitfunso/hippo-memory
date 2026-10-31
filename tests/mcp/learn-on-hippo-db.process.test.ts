// hippo_learn, the MCP tool on hippo.db's local tier, as `hippo serve` runs it: bound once at boot,
// each call runs on its request's store, so every store call it makes carries that request's deadline.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteExecutor } from '../../src/store/sqlite/runtime/executor.js';
import { workerSqliteStore } from '../../src/store/sqlite/runtime/worker-store.js';
import { recordingExecutor } from '../_helpers/recording-executor.js';
import { cleanups, keyFor, newRoot, post, removeLater, start, undoAll } from '../_helpers/store-worker-server.js';

// Far past the call, so it bounds each store call without ending one.
const DEADLINE_MS = '30000';
const LESSON = 'fix the retry loop that dropped the last queued webhook delivery';

/** A git repo whose one commit hippo_learn reads as a lesson. */
function repoWithLesson(): string {
  const dir = removeLater(mkdtempSync(join(tmpdir(), 'hippo-learn-tier-')));
  const git = (...args: readonly string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  };
  git('init', '-q');
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'a.txt'), 'a');
  git('add', '.');
  git('commit', '-q', '-m', LESSON);
  return dir;
}

afterEach(undoAll);

describe('hippo_learn over HTTP MCP on the worker store', () => {
  it("runs on the request's store, so each of its store calls carries the request's deadline", async () => {
    // The server's machine reads its git from the folder it starts in.
    const repo = repoWithLesson();
    const saved = process.cwd();
    process.chdir(repo);
    cleanups.push(() => process.chdir(saved));
    const root = newRoot('learn-tier');
    const { executor, sent } = recordingExecutor(createSqliteExecutor(root));
    const server = await start(root, workerSqliteStore(root, executor));
    const { plaintext } = keyFor(root, 'default');
    vi.stubEnv('HIPPO_REQUEST_DEADLINE_MS', DEADLINE_MS);
    const before = sent.length;
    const res = await post(
      server,
      '/mcp',
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hippo_learn', arguments: { days: 3650 } } },
      plaintext,
    );
    // SAFETY: POST /mcp answers a tools/call with a JSON-RPC envelope whose result wraps the tool's text.
    const body = (await res.json()) as { result?: { content?: Array<{ text?: string }> } };
    expect(body.result?.content?.[0]?.text).toMatch(/^Git learn: 1 new/);
    const learned = sent.slice(before).filter(({ op }) => op.startsWith('hippoDb.lessonWrites.'));
    expect(learned.map(({ op }) => op)).toContain('hippoDb.lessonWrites.writeSkippingRejected');
    expect(learned.filter(({ deadlineAt }) => deadlineAt === undefined)).toEqual([]);
  });
});
