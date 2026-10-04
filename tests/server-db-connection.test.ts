// A running server keeps one store connection open, so a request's own close is never SQLite's last-connection close.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { serve, type ServerHandle } from '../src/server.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function post(handle: ServerHandle, content: string): Promise<number> {
  const res = await fetch(`${handle.url}/v1/memories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ content, kind: 'distilled' }),
  });
  await res.text();
  return res.status;
}

describe('hippo serve store connection', () => {
  it('keeps the WAL between requests while running, and releases the store on stop', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hippo-srv-conn-'));
    dirs.push(root);
    initStore(root);
    const wal = join(root, 'hippo.db-wal');
    const handle = await serve({ hippoRoot: root, port: 0 });
    try {
      expect(await post(handle, 'the staging queue drains at midnight')).toBe(200);
      // Without a held connection each request's close is the last one, which checkpoints and deletes the WAL.
      expect(existsSync(wal)).toBe(true);
      expect(await post(handle, 'the release branch is cut on Thursdays')).toBe(200);
      expect(existsSync(wal)).toBe(true);
    } finally {
      await handle.stop();
    }
    expect(existsSync(wal)).toBe(false);
  });

  it('holds the store a first write creates, and never creates one on its own', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hippo-srv-conn-fresh-'));
    dirs.push(root);
    const handle = await serve({ hippoRoot: root, port: 0 });
    try {
      expect(existsSync(join(root, 'hippo.db'))).toBe(false);
      expect(await post(handle, 'the staging queue drains at midnight')).toBe(200);
      expect(await post(handle, 'the release branch is cut on Thursdays')).toBe(200);
      expect(existsSync(join(root, 'hippo.db-wal'))).toBe(true);
    } finally {
      await handle.stop();
    }
  });
});
