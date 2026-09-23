import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'node:child_process';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory } from '../src/memory.js';
import { embedAll, loadEmbeddingIndex } from '../src/embeddings.js';

const KEY_ENV = 'OPENAI_API_KEY';
let root: string;
let savedKey: string | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-embed-lock-'));
  initStore(root);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ embeddings: { provider: 'openai', model: 'm' } }), 'utf8');
  writeEntry(root, createMemory('embed lock test memory'));
  savedKey = process.env[KEY_ENV];
  process.env[KEY_ENV] = ['sk', 'test'].join('-');
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] })));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = savedKey;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('embeddings.json cross-process lock', () => {
  it('breaks a lock left by a dead process and removes its own lock after', async () => {
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    fs.writeFileSync(path.join(root, 'embeddings.lock'), String(deadPid));
    expect(await embedAll(root)).toBe(1);
    expect(Object.keys(loadEmbeddingIndex(root))).toHaveLength(1);
    expect(fs.existsSync(path.join(root, 'embeddings.lock'))).toBe(false);
  });

  it('waits for a live holder, then writes once the lock is released', async () => {
    const lockPath = path.join(root, 'embeddings.lock');
    fs.writeFileSync(lockPath, String(process.pid));
    const pending = embedAll(root);
    await new Promise((r) => setTimeout(r, 150));
    expect(fetchMock).not.toHaveBeenCalled();
    fs.rmSync(lockPath);
    expect(await pending).toBe(1);
    expect(fetchMock).toHaveBeenCalled();
  });
});
