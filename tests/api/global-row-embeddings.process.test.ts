import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promote } from '../../src/api/hippo-db/promote.js';
import { shareMemory, autoShare } from '../../src/domain/sharing/share.js';
import { syncGlobalToLocal } from '../../src/domain/sharing/global-sync.js';
import { createMemory } from '../../src/entry/memory.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { embedAll } from '../../src/domain/search/embed-memories.js';
import { isEmbeddingAvailable } from '../../src/base/embeddings/local.js';
import { skipWithoutEmbeddings } from '../_helpers/embedding-backend.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { runCli } from '../../src/cli.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { resolveEmbeddingProvider } from '../../src/infra/embedding-provider.js';
import { loadConfig } from '../../src/host/config-file.js';
import { sharingStores } from '../_helpers/sharing-stores.js';
import { startHashedEmbeddings, type HashedEmbeddings } from '../_helpers/hashed-embedding-server.js';
import { runCliAs } from '../_helpers/run-cli-as.js';
import { localIndex } from '../_helpers/cli-stores.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry, loadEmbeddingIndex } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { ALL_TENANTS } from '../../src/base/util/tenant.js';
import { TEST_DETACHED, TEST_RUN } from '../_helpers/test-run.js';

// docs/plans/2026-07-18-global-row-embeddings.md: rows written to the global
// store by promote/share/autoShare/sync/import must enter that store's
// embedding index under the same best-effort contract as `remember`.

const HIPPO_BIN = fileURLToPath(new URL('../../bin/hippo.js', import.meta.url));
// Xenova/all-MiniLM-L6-v2, the default local embedding model these stores use, emits 384 numbers.
const MINILM_DIMENSIONS = 384;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpStore(): string {
  const dir = makeRoot('gre');
  return dir;
}

function disableEmbeddings(root: string): void {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ embeddings: { enabled: false } }), 'utf8');
}

function cleanUp(...dirs: string[]): void {
  for (const d of dirs) {
    fs.rmSync(d, { recursive: true, force: true });
  }
}

let _embeddingFunctional: boolean | null = null;

// isEmbeddingAvailable() only proves the package resolves; one real embed call (cached) proves the pipeline loads
// before a test depends on a vector.
async function embeddingIsFunctional(): Promise<boolean> {
  if (_embeddingFunctional !== null) return _embeddingFunctional;
  if (!isEmbeddingAvailable()) {
    _embeddingFunctional = false;
    return false;
  }
  const probeRoot = makeRoot('gre-probe');
  const provider = resolveEmbeddingProvider(loadConfig(probeRoot).embeddings);
  const [vector] = await provider.embed(['embedding functional probe'], 'passage');
  _embeddingFunctional = Array.isArray(vector) && vector.length > 0;
  return _embeddingFunctional;
}

// ---------------------------------------------------------------------------
// Deterministic: embeddings.enabled=false on the destination store
// ---------------------------------------------------------------------------

describe('global-row-embeddings: embeddings disabled (deterministic)', () => {
  let localRoot: string;
  let globalRoot: string;

  beforeEach(() => {
    localRoot = makeTmpStore();
    globalRoot = makeTmpStore();
    disableEmbeddings(globalRoot);
    vi.stubEnv('HIPPO_HOME', globalRoot);
  });

  afterEach(() => {
    cleanUp(localRoot, globalRoot);
  });

  it('promote succeeds and writes no embedding index entry', async () => {
    const entry = createMemory('deterministic no-embed promote test content', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    });
    writeEntry(localRoot, entry);

    const promoted = await promote(apiCtx(localRoot), entry.id);
    expect(promoted.globalId).toMatch(/^g_/);

    // provider.isAvailable() is synchronous and false here (config-disabled),
    // so embedMemory's fire-and-forget call returns before any fs write,
    // no waitFor needed, the absence is observable immediately.
    const index = loadEmbeddingIndex(globalRoot);
    expect(index[promoted.globalId]).toBeUndefined();
  });

  it('shareMemory succeeds and writes no embedding index entry', async () => {
    const entry = createMemory('deterministic no-embed share test content', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      tags: ['error'],
    });
    writeEntry(localRoot, entry);

    const shared = await shareMemory(...sharingStores(localRoot), entry.id, {
      embed: TEST_RUN,
      detached: TEST_DETACHED,
      tenantId: 'default',
      force: true,
    });
    expect(shared).not.toBeNull();
    expect(shared!.id).toMatch(/^g_/);

    const index = loadEmbeddingIndex(globalRoot);
    expect(index[shared!.id]).toBeUndefined();
  });

  it('autoShare succeeds and writes no embedding index entry (skipEmbed + batch embedAll no-op)', async () => {
    const entry = createMemory('deterministic no-embed autoshare test content', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    });
    writeEntry(localRoot, entry);

    const shared = await autoShare(...sharingStores(localRoot), {
      embed: TEST_RUN,
      detached: TEST_DETACHED,
      tenantId: ALL_TENANTS,
      minScore: 0,
    });
    expect(shared.length).toBe(1);

    const index = loadEmbeddingIndex(globalRoot);
    expect(index[shared[0].id]).toBeUndefined();
  });

  it('syncGlobalToLocal succeeds and writes no embedding index entry on the local store', async () => {
    disableEmbeddings(localRoot);
    const entry = createMemory('deterministic no-embed sync test content', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    });
    writeEntry(globalRoot, entry);

    const count = await syncGlobalToLocal(...sharingStores(localRoot, globalRoot), {
      embed: TEST_RUN,
      detached: TEST_DETACHED,
    });
    expect(count).toBe(1);

    const index = loadEmbeddingIndex(localRoot);
    expect(index[entry.id]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Awaited batch producers (embeddings available)
// ---------------------------------------------------------------------------

describe('global-row-embeddings: awaited batch producers', () => {
  let localRoot: string;
  let globalRoot: string;

  beforeEach(() => {
    localRoot = makeTmpStore();
    globalRoot = makeTmpStore();
    vi.stubEnv('HIPPO_HOME', globalRoot);
  });

  afterEach(() => {
    cleanUp(localRoot, globalRoot);
  });

  it('syncGlobalToLocal-copied rows gain vectors after an awaited embedAll(localRoot)', async (ctx) => {
    skipWithoutEmbeddings(ctx, await embeddingIsFunctional());
    const entry = createMemory('awaited batch sync test content unique alpha', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    });
    writeEntry(globalRoot, entry);

    const count = await syncGlobalToLocal(...sharingStores(localRoot, globalRoot), {
      embed: TEST_RUN,
      detached: TEST_DETACHED,
    });
    expect(count).toBe(1);

    // syncGlobalToLocal already fired its own embedAll(localRoot); this call
    // is idempotent and, because embed writes are serialized through the
    // module's embed lock, awaiting it guarantees the earlier fire-and-forget
    // call has also settled by the time this resolves.
    await embedAll(localIndex(localRoot));

    const index = loadEmbeddingIndex(localRoot);
    expect(index[entry.id]).toHaveLength(MINILM_DIMENSIONS);
  }, 60_000);

  it('autoShare-shared rows gain vectors after an awaited embedAll(globalRoot)', async (ctx) => {
    skipWithoutEmbeddings(ctx, await embeddingIsFunctional());
    const entry = createMemory('awaited batch autoshare test content unique beta', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    });
    writeEntry(localRoot, entry);

    const shared = await autoShare(...sharingStores(localRoot), {
      embed: TEST_RUN,
      detached: TEST_DETACHED,
      tenantId: ALL_TENANTS,
      minScore: 0,
    });
    expect(shared.length).toBe(1);

    await embedAll(localIndex(globalRoot));

    const index = loadEmbeddingIndex(globalRoot);
    expect(index[shared[0].id]).toHaveLength(MINILM_DIMENSIONS);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Single-row producers: the call waits for the embed of its copy
// ---------------------------------------------------------------------------

describe('global-row-embeddings: promote waits for its embed', () => {
  let localRoot: string;
  let globalRoot: string;

  beforeEach(() => {
    localRoot = makeTmpStore();
    globalRoot = makeTmpStore();
    vi.stubEnv('HIPPO_HOME', globalRoot);
  });

  afterEach(() => {
    cleanUp(localRoot, globalRoot);
  });

  // Generous timeout: first-run model load can be slow.
  it('promote embeds the global copy before it returns', async (ctx) => {
    skipWithoutEmbeddings(ctx, await embeddingIsFunctional());
    const entry = createMemory('promote waits for its embed test content gamma', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    });
    writeEntry(localRoot, entry);

    const promoted = await promote(apiCtx(localRoot), entry.id);

    expect(loadEmbeddingIndex(globalRoot)[promoted.globalId]).toHaveLength(MINILM_DIMENSIONS);
  }, 35_000);
});

describe('global-row-embeddings: the first promote, before any global store exists', () => {
  let localRoot: string;
  let globalRoot: string;
  let embeddings: HashedEmbeddings;

  beforeEach(async () => {
    embeddings = await startHashedEmbeddings();
    localRoot = makeTmpStore();
    globalRoot = makeRoot('gre-noglobal', { init: false });
    // Only hippo.db marks a store as initialized, so the context's reach has no global store yet.
    const config = { embeddings: { provider: 'openai', model: 'hashed-16', apiBaseUrl: embeddings.url } };
    fs.writeFileSync(path.join(globalRoot, 'config.json'), JSON.stringify(config), 'utf8');
    vi.stubEnv('HIPPO_HOME', globalRoot);
    vi.stubEnv('OPENAI_API_KEY', 'test-key-not-secret');
  });

  afterEach(async () => {
    await embeddings.close();
    cleanUp(localRoot, globalRoot);
    vi.unstubAllEnvs();
  });

  it('embeds the copy into the global store the promote created', async () => {
    const entry = createMemory('first promote embeds into a new global store', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    });
    writeEntry(localRoot, entry);
    const ctx = apiCtx(localRoot);
    expect(ctx.reach?.global).toBeUndefined();

    const promoted = await promote(ctx, entry.id);

    expect(loadEmbeddingIndex(globalRoot)[promoted.globalId]).toHaveLength(16);
  });
});

// ---------------------------------------------------------------------------
// hippo embed --global (CLI)
// ---------------------------------------------------------------------------

describe('global-row-embeddings: hippo embed --global CLI', () => {
  it('embeds a seeded global row from a cwd with no local store, without requireInit failing', async () => {
    const home = makeRoot('gre-cli-home', { init: false });
    const cwd = makeRoot('gre-cli-cwd', { init: false });
    const globalRoot = path.join(home, '.hippo');
    const env = { ...process.env, HIPPO_HOME: globalRoot };

    try {
      // Seed an unembedded global row directly, bypassing the CLI, so the
      // row predates any embed call.
      initTestStore(globalRoot);
      const entry = createMemory('cli embed --global test content delta', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
      writeEntry(globalRoot, entry);

      // In process, so coverage sees the embed verb; the promote wiring case below keeps the real child.
      const { status: exitCode, stderr } = await runCliAs(['embed', '--global'], { cwd, env });

      // Ungated: cwd has no local .hippo at all, so --global must skip
      // requireInit entirely (the r1 must-fix), regardless of embedding
      // availability in this environment.
      expect(stderr).not.toMatch(/No \.hippo directory found/);

      if (isEmbeddingAvailable()) {
        expect(exitCode).toBe(0);
        const index = loadEmbeddingIndex(globalRoot);
        expect(index[entry.id]).toHaveLength(MINILM_DIMENSIONS);
      }
    } finally {
      cleanUp(home, cwd);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// promote producer wiring (subprocess, real node process)
// ---------------------------------------------------------------------------

describe('global-row-embeddings: promote producer wiring (subprocess)', () => {
  // Real-process counterpart of the in-process "promote waits for its embed"
  // test above; it covers the built CLI path. Spawns real `node` subprocesses
  // (same pattern as the "hippo embed --global CLI" test above) so the actual
  // promote -> embedMemory fire is exercised end-to-end: init, remember,
  // embed (warms the local vector + model cache), promote, then poll the
  // GLOBAL store's embedding index for the minted g_ id. A producer-wiring
  // regression (wrong root, dropped void embed call) would fail this test even
  // when every in-process test above is skipping.
  it('promoting a remembered row lands a vector in the GLOBAL embedding index', async () => {
    const home = makeRoot('gre-wiring-home', { init: false });
    const cwd = makeRoot('gre-wiring-cwd', { init: false });
    const globalRoot = path.join(home, '.hippo');
    const env = { ...process.env, HIPPO_HOME: globalRoot };

    try {
      execFileSync('node', [HIPPO_BIN, 'init', '--no-hooks', '--no-schedule', '--no-learn'], {
        cwd,
        env,
        encoding: 'utf-8',
      });

      const nonce = `wiring-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const rememberOut = execFileSync('node', [HIPPO_BIN, 'remember', `${nonce} wiring probe`], {
        cwd,
        env,
        encoding: 'utf-8',
      });
      const rememberMatch = rememberOut.match(/Remembered \[(\S+)\]/);
      expect(rememberMatch).not.toBeNull();
      const localId = rememberMatch![1];

      // Ensures the local vector exists (deterministic, not racing remember's
      // own fire-and-forget embed) and warms the on-disk model cache before
      // promote runs.
      if (isEmbeddingAvailable()) execFileSync('node', [HIPPO_BIN, 'embed'], { cwd, env, encoding: 'utf-8' });

      const promoteOut = execFileSync('node', [HIPPO_BIN, 'promote', localId], { cwd, env, encoding: 'utf-8' });
      const promoteMatch = promoteOut.match(/Promoted \S+ to global store as (\S+)/);
      expect(promoteMatch).not.toBeNull();
      const globalId = promoteMatch![1];
      expect(globalId).toMatch(/^g_/);

      // The command settles its embeds before it exits, so the vector is there once execFileSync returns.
      if (isEmbeddingAvailable()) expect(loadEmbeddingIndex(globalRoot)[globalId]).toHaveLength(MINILM_DIMENSIONS);
    } finally {
      cleanUp(home, cwd);
    }
  }, 90_000);
});

// ---------------------------------------------------------------------------
// CLI verbs: each embeds the rows it copies before the command returns, since the command's runtime closes then
// ---------------------------------------------------------------------------

describe('global-row-embeddings: a CLI verb that copies rows embeds them before it returns', () => {
  // Long enough that a command which does not wait for its embed returns first.
  const EMBED_DELAY_MS = 300;
  const savedCwd = process.cwd();
  let localRoot: string;
  let globalRoot: string;
  let embeddings: HashedEmbeddings;

  beforeEach(async () => {
    const cwd = makeRoot('verb-embeds', { init: false });
    localRoot = path.join(cwd, '.hippo');
    globalRoot = path.join(cwd, 'global-hippo');
    initTestStore(localRoot);
    initTestStore(globalRoot);
    embeddings = await startHashedEmbeddings();
    embeddings.setFault(EMBED_DELAY_MS);
    const config = { embeddings: { provider: 'openai', model: 'hashed-16', apiBaseUrl: embeddings.url } };
    for (const root of [localRoot, globalRoot]) {
      fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
    }
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
