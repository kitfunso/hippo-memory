// promote, share and sync embed the rows they copy before the command returns: the command's store
// runtime closes then, so an embed still running would write through a closed runtime.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../src/cli.js';
import { createMemory } from '../../src/entry/memory.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadEmbeddingIndex, writeEntry } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { startHashedEmbeddings, type HashedEmbeddings } from '../_helpers/hashed-embedding-server.js';

// Long enough that a command which does not wait for its embed returns first.
const EMBED_DELAY_MS = 300;

const savedCwd = process.cwd();
let cwd: string;
let localRoot: string;
let globalRoot: string;
let embeddings: HashedEmbeddings;

beforeEach(async () => {
  cwd = makeRoot('verb-embeds', { init: false });
  localRoot = join(cwd, '.hippo');
  globalRoot = join(cwd, 'global-hippo');
  initTestStore(localRoot);
  initTestStore(globalRoot);
  embeddings = await startHashedEmbeddings();
  embeddings.setFault(EMBED_DELAY_MS);
  const config = { embeddings: { provider: 'openai', model: 'hashed-16', apiBaseUrl: embeddings.url } };
  for (const root of [localRoot, globalRoot]) writeFileSync(join(root, 'config.json'), JSON.stringify(config));
  vi.stubEnv('OPENAI_API_KEY', 'test-key-not-secret');
  vi.stubEnv('HIPPO_HOME', globalRoot);
  vi.stubEnv('HIPPO_TENANT', 'default');
  vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
  process.chdir(cwd);
});
afterEach(async () => {
  await embeddings.close();
  process.chdir(savedCwd);
  vi.unstubAllEnvs();
});

async function hippo(...args: string[]): Promise<string> {
  const r = await runInProcess(() => runCli(['node', 'hippo', ...args]));
  expect(r.status).toBe(0);
  return r.stdout;
}

function seed(root: string, content: string): string {
  const entry = createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
  writeEntry(root, entry);
  return entry.id;
}

const vectorOf = (root: string, id: string): number[] | undefined => loadEmbeddingIndex(root)[id];

describe('a CLI verb that copies rows embeds them before it returns', () => {
  it('hippo promote', async () => {
    const id = seed(localRoot, 'promote keeps the release checklist in the global store');
    const out = await hippo('promote', id);
    const globalId = /as (g_\S+)/.exec(out)?.[1] ?? '';
    expect(globalId).toMatch(/^g_/);
    expect(vectorOf(globalRoot, globalId)).toHaveLength(16);
  });

  it('hippo share <id>', async () => {
    const id = seed(localRoot, 'share keeps the deploy rollback steps in the global store');
    const out = await hippo('share', id, '--force');
    const globalId = /Shared \[(g_\S+)\]/.exec(out)?.[1] ?? '';
    expect(globalId).toMatch(/^g_/);
    expect(vectorOf(globalRoot, globalId)).toHaveLength(16);
  });

  it('hippo share --auto', async () => {
    seed(localRoot, 'auto share copies the on-call runbook to the global store');
    const out = await hippo('share', '--auto', '--min-score', '0');
    const ids = [...out.matchAll(/^ {2}(g_\S+) <- /gm)].map((m) => m[1]);
    expect(ids).toHaveLength(1);
    expect(vectorOf(globalRoot, ids[0])).toHaveLength(16);
  });

  it('hippo sync', async () => {
    const id = seed(globalRoot, 'sync brings the shared coding conventions into the project');
    expect(await hippo('sync')).toMatch(/Synced 1 global memories/);
    expect(vectorOf(localRoot, id)).toHaveLength(16);
  });
});
