// The store's open-time setup runs on the writer thread before any reader thread is sent a job, since a reader's connection refuses the writes setup makes.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getHippoDbPath, getMeta } from '../src/db/index.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';
import type { ServerHandle } from '../src/server.js';
import { serializeEntry } from '../src/store/markdown.js';
import { HALF_LIFE_BASE_META_KEY } from '../src/store/open.js';
import { createSqliteExecutor } from '../src/store/sqlite/executor.js';
import { cleanups, execOn, get, holdWriteLock, newRoot, onDb, post, removeLater, start, undoAll } from './_helpers/store-worker-server.js';

afterEach(undoAll);

const bareRoot = (): string => removeLater(mkdtempSync(join(tmpdir(), 'hippo-setup-first-')));

const halfLifeBase = (root: string): string => onDb(root, (db) => getMeta(db, HALF_LIFE_BASE_META_KEY, ''));

/** A memory as a store kept it before hippo.db: one markdown file, which setup imports while the store has no memory row. */
function legacyMarkdown(root: string, content: string): void {
  const entry = createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
  mkdirSync(join(root, 'episodic'), { recursive: true });
  writeFileSync(join(root, 'episodic', `${entry.id}.md`), serializeEntry(entry));
}

async function recalled(server: ServerHandle, query: string): Promise<string[]> {
  const res = await get(server, `/v1/memories?q=${query}`);
  expect(res.status).toBe(200);
  // SAFETY: a 200 from GET /v1/memories is a serialised RecallResult.
  const body = (await res.json()) as { results: Array<{ content: string }> };
  return body.results.map((row) => row.content);
}

describe('a root with no hippo.db', () => {
  it('answers its first request, a read, from a reader, after the writer recorded what a new store records', async () => {
    const root = bareRoot();
    const server = await start(root);

    const graph = await get(server, '/v1/graph');

    expect(graph.status).toBe(200);
    // The graph read writes nothing, so only the setup can have recorded this.
    expect(halfLifeBase(root)).toBe(String(DEFAULT_HALF_LIFE_DAYS));
    const rest = [
      await get(server, '/v1/quarantine'),
      await get(server, '/v1/memories?q=deploy'),
      await get(server, '/v1/sessions/sess-1/assemble'),
      await post(server, '/v1/memories/mem_000000000000/supersede', { content: 'never saved' }),
    ];
    expect(rest.map((res) => res.status)).toEqual([200, 200, 200, 404]);
  });

  it('imports the markdown memories of an older store before the first read, which returns them', async () => {
    const root = bareRoot();
    legacyMarkdown(root, 'the legacy deploy runbook lives in the wiki');
    const server = await start(root);

    expect(await recalled(server, 'runbook')).toEqual(['the legacy deploy runbook lives in the wiki']);
  });
});

describe('markdown that appears on a still empty store after the setup', () => {
  it('is left alone by a reader, which still answers, and is imported by the next write', async () => {
    const root = newRoot('setup-first');
    const server = await start(root);
    expect((await get(server, '/v1/sessions/sess-1/assemble')).status).toBe(200);
    legacyMarkdown(root, 'a runbook copied in while the server ran');

    const read = await get(server, '/v1/sessions/sess-1/assemble');

    expect(read.status).toBe(200);
    expect((await post(server, '/v1/memories', { content: 'the first note written here' })).status).toBe(200);
    expect(await recalled(server, 'runbook')).toEqual(['a runbook copied in while the server ran']);
  });
});

describe('a setup still waiting for the write lock', () => {
  it('holds the read sent with it, which answers once the setup has written', async () => {
    const root = newRoot('setup-first');
    // An empty store with no recorded base: the setup has one row to write, and the lock below makes it wait.
    execOn(root, `DELETE FROM meta WHERE key = '${HALF_LIFE_BASE_META_KEY}'`);
    const executor = createSqliteExecutor(root, { busyWaitMs: 60_000 });
    cleanups.push(() => executor.close());
    // Taken after the executor, so a failed run gives the lock up before it waits for the threads to exit.
    const lock = holdWriteLock(root);
    let answered = false;
    const read = executor.call('readiness.ping', [], { mode: 'read', requestId: undefined }).then(() => {
      answered = true;
    });

    // Long past a reader thread's start, so a read sent to a reader at once would have answered.
    await delay(1_500);

    expect(answered).toBe(false);
    lock.release();
    await read;
    expect(halfLifeBase(root)).toBe(String(DEFAULT_HALF_LIFE_DAYS));
  });
});

describe('a setup that fails', () => {
  it('fails the read that waited for it with its own error, and the next call runs it again', async () => {
    const root = bareRoot();
    // A folder where the file belongs: no connection can open it.
    mkdirSync(getHippoDbPath(root));
    const executor = createSqliteExecutor(root);
    cleanups.push(() => executor.close());
    const read = (): Promise<void> => executor.call('readiness.ping', [], { mode: 'read', requestId: undefined });

    await expect(read()).rejects.toThrow(/unable to open database file/);
    rmdirSync(getHippoDbPath(root));

    await expect(read()).resolves.toBeUndefined();
    expect(halfLifeBase(root)).toBe(String(DEFAULT_HALF_LIFE_DAYS));
  });
});
