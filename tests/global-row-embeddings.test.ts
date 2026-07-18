import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'node:child_process';
import {
  promoteToGlobal,
  shareMemory,
  autoShare,
  syncGlobalToLocal,
} from '../src/shared.js';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory } from '../src/memory.js';
import { embedAll, loadEmbeddingIndex, isEmbeddingAvailable } from '../src/embeddings.js';
import { resolveEmbeddingProvider } from '../src/embedding-provider.js';

// docs/plans/2026-07-18-global-row-embeddings.md: rows written to the global
// store by promote/share/autoShare/sync/import must enter that store's
// embedding index under the same best-effort contract as `remember`.

const HIPPO_BIN = path.join(process.cwd(), 'bin', 'hippo.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-gre-'));
  initStore(dir);
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

/**
 * isEmbeddingAvailable() only confirms the local provider package resolves;
 * it does not confirm the pipeline can actually load in-process. Under
 * vitest's VM-based test execution, embeddings.ts's `_dynImport` (a
 * `new Function('s', 'return import(s)')` trick used to keep the peer dep
 * optional) throws ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING because it escapes
 * Vite's SSR module graph. That is a harness limitation, not a producer-
 * wiring bug: the identical call embeds successfully in a plain `node`
 * script outside vitest, and the CLI test below (which spawns a real `node`
 * subprocess) is unaffected. Probe once with a real embed call and cache the
 * result, so in-process tests that need a genuine vector skip cleanly here
 * instead of failing on an empty/undefined one.
 */
async function embeddingIsFunctional(): Promise<boolean> {
  if (_embeddingFunctional !== null) return _embeddingFunctional;
  if (!isEmbeddingAvailable()) {
    _embeddingFunctional = false;
    return false;
  }
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-gre-probe-'));
  try {
    initStore(probeRoot);
    const provider = resolveEmbeddingProvider(probeRoot);
    const [vector] = await provider.embed(['embedding functional probe'], 'passage');
    _embeddingFunctional = Array.isArray(vector) && vector.length > 0;
  } catch (err) {
    // Only the documented VM limitation (see the comment above) is a known
    // "unavailable in this harness" condition. Anything else is a genuine
    // embed-pipeline regression and must fail loud, not masquerade as a skip.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    const message = err instanceof Error ? err.message : String(err);
    const isKnownVmLimitation =
      code === 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING' ||
      message.includes('ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING');
    if (!isKnownVmLimitation) throw err;
    _embeddingFunctional = false;
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
  return _embeddingFunctional;
}

// ---------------------------------------------------------------------------
// Deterministic: embeddings.enabled=false on the destination store
// ---------------------------------------------------------------------------

describe('global-row-embeddings: embeddings disabled (deterministic)', () => {
  let localRoot: string;
  let globalRoot: string;
  let prevHippoHome: string | undefined;

  beforeEach(() => {
    localRoot = makeTmpStore();
    globalRoot = makeTmpStore();
    disableEmbeddings(globalRoot);
    // promoteToGlobal/shareMemory/autoShare resolve their destination via
    // getGlobalRoot(), which reads HIPPO_HOME (same isolation pattern as
    // tests/shared.test.ts's promoteToGlobal describe block).
    prevHippoHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = globalRoot;
  });

  afterEach(() => {
    if (prevHippoHome === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = prevHippoHome;
    cleanUp(localRoot, globalRoot);
  });

  it('promoteToGlobal succeeds and writes no embedding index entry', () => {
    const entry = createMemory('deterministic no-embed promote test content');
    writeEntry(localRoot, entry);

    const promoted = promoteToGlobal(localRoot, entry.id);
    expect(promoted.id).toMatch(/^g_/);

    // provider.isAvailable() is synchronous and false here (config-disabled),
    // so embedMemory's fire-and-forget call returns before any fs write,
    // no waitFor needed, the absence is observable immediately.
    const index = loadEmbeddingIndex(globalRoot);
    expect(index[promoted.id]).toBeUndefined();
  });

  it('shareMemory succeeds and writes no embedding index entry', () => {
    const entry = createMemory('deterministic no-embed share test content', { tags: ['error'] });
    writeEntry(localRoot, entry);

    const shared = shareMemory(localRoot, entry.id, { force: true });
    expect(shared).not.toBeNull();
    expect(shared!.id).toMatch(/^g_/);

    const index = loadEmbeddingIndex(globalRoot);
    expect(index[shared!.id]).toBeUndefined();
  });

  it('autoShare succeeds and writes no embedding index entry (skipEmbed + batch embedAll no-op)', () => {
    const entry = createMemory('deterministic no-embed autoshare test content');
    writeEntry(localRoot, entry);

    const shared = autoShare(localRoot, { minScore: 0 });
    expect(shared.length).toBe(1);

    const index = loadEmbeddingIndex(globalRoot);
    expect(index[shared[0].id]).toBeUndefined();
  });

  it('syncGlobalToLocal succeeds and writes no embedding index entry on the local store', () => {
    disableEmbeddings(localRoot);
    const entry = createMemory('deterministic no-embed sync test content');
    writeEntry(globalRoot, entry);

    const count = syncGlobalToLocal(localRoot, globalRoot);
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
  let prevHippoHome: string | undefined;

  beforeEach(() => {
    localRoot = makeTmpStore();
    globalRoot = makeTmpStore();
    prevHippoHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = globalRoot;
  });

  afterEach(() => {
    if (prevHippoHome === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = prevHippoHome;
    cleanUp(localRoot, globalRoot);
  });

  it('syncGlobalToLocal-copied rows gain vectors after an awaited embedAll(localRoot)', async () => {
    if (!(await embeddingIsFunctional())) {
      console.warn('SKIP: embeddings unavailable in this environment');
      return;
    }
    const entry = createMemory('awaited batch sync test content unique alpha');
    writeEntry(globalRoot, entry);

    const count = syncGlobalToLocal(localRoot, globalRoot);
    expect(count).toBe(1);

    // syncGlobalToLocal already fired its own embedAll(localRoot); this call
    // is idempotent and, because embed writes are serialized through the
    // module's embed lock, awaiting it guarantees the earlier fire-and-forget
    // call has also settled by the time this resolves.
    await embedAll(localRoot);

    const index = loadEmbeddingIndex(localRoot);
    expect(index[entry.id]).toBeDefined();
    expect(index[entry.id].length).toBeGreaterThan(0);
  }, 60_000);

  it('autoShare-shared rows gain vectors after an awaited embedAll(globalRoot)', async () => {
    if (!(await embeddingIsFunctional())) {
      console.warn('SKIP: embeddings unavailable in this environment');
      return;
    }
    const entry = createMemory('awaited batch autoshare test content unique beta');
    writeEntry(localRoot, entry);

    const shared = autoShare(localRoot, { minScore: 0 });
    expect(shared.length).toBe(1);

    await embedAll(globalRoot);

    const index = loadEmbeddingIndex(globalRoot);
    expect(index[shared[0].id]).toBeDefined();
    expect(index[shared[0].id].length).toBeGreaterThan(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Fire-and-forget integration (single-row producers, no explicit embedAll)
// ---------------------------------------------------------------------------

describe('global-row-embeddings: fire-and-forget integration', () => {
  let localRoot: string;
  let globalRoot: string;
  let prevHippoHome: string | undefined;

  beforeEach(() => {
    localRoot = makeTmpStore();
    globalRoot = makeTmpStore();
    prevHippoHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = globalRoot;
  });

  afterEach(() => {
    if (prevHippoHome === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = prevHippoHome;
    cleanUp(localRoot, globalRoot);
  });

  it('promoteToGlobal fire-and-forget embed eventually lands in the global index', async () => {
    if (!(await embeddingIsFunctional())) {
      console.warn('SKIP: embeddings unavailable in this environment');
      return;
    }
    const entry = createMemory('fire and forget integration promote test content gamma');
    writeEntry(localRoot, entry);

    const promoted = promoteToGlobal(localRoot, entry.id);

    // Generous timeout: first-run model load can be slow.
    await vi.waitFor(() => {
      const index = loadEmbeddingIndex(globalRoot);
      expect(index[promoted.id]).toBeDefined();
    }, { timeout: 30_000, interval: 250 });
  }, 35_000);
});

// ---------------------------------------------------------------------------
// hippo embed --global (CLI)
// ---------------------------------------------------------------------------

describe('global-row-embeddings: hippo embed --global CLI', () => {
  it('embeds a seeded global row from a cwd with no local store, without requireInit failing', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-gre-cli-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-gre-cli-cwd-'));
    const globalRoot = path.join(home, '.hippo');
    const env = { ...process.env, HIPPO_HOME: globalRoot };

    try {
      // Seed an unembedded global row directly, bypassing the CLI, so the
      // row predates any embed call.
      initStore(globalRoot);
      const entry = createMemory('cli embed --global test content delta');
      writeEntry(globalRoot, entry);

      let exitCode = 0;
      let stderr = '';
      try {
        execFileSync('node', [HIPPO_BIN, 'embed', '--global'], { cwd, env, encoding: 'utf-8' });
      } catch (err) {
        const e = err as { status?: number | null; stderr?: string };
        exitCode = e.status ?? 1;
        stderr = e.stderr ?? '';
      }

      // Ungated: cwd has no local .hippo at all, so --global must skip
      // requireInit entirely (the r1 must-fix), regardless of embedding
      // availability in this environment.
      expect(stderr).not.toMatch(/No \.hippo directory found/);

      if (isEmbeddingAvailable()) {
        expect(exitCode).toBe(0);
        const index = loadEmbeddingIndex(globalRoot);
        expect(index[entry.id]).toBeDefined();
      }
    } finally {
      cleanUp(home, cwd);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// promoteToGlobal producer wiring (subprocess, real node process)
// ---------------------------------------------------------------------------

describe('global-row-embeddings: promoteToGlobal producer wiring (subprocess)', () => {
  // Real-process counterpart of the in-process "fire-and-forget integration"
  // test above, which skips under vitest's VM (embeddingIsFunctional() ->
  // ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING). Spawns real `node` subprocesses
  // (same pattern as the "hippo embed --global CLI" test above) so the actual
  // promoteToGlobal -> embedMemory fire is exercised end-to-end: init, remember,
  // embed (warms the local vector + model cache), promote, then poll the
  // GLOBAL store's embedding index for the minted g_ id. A producer-wiring
  // regression (wrong root, dropped void embed call) would fail this test even
  // when every in-process test above is skipping.
  it('promoting a remembered row lands a vector in the GLOBAL embedding index', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-gre-wiring-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-gre-wiring-cwd-'));
    const globalRoot = path.join(home, '.hippo');
    const env = { ...process.env, HIPPO_HOME: globalRoot };

    try {
      execFileSync(
        'node',
        [HIPPO_BIN, 'init', '--no-hooks', '--no-schedule', '--no-learn'],
        { cwd, env, encoding: 'utf-8' },
      );

      const nonce = `wiring-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const rememberOut = execFileSync(
        'node',
        [HIPPO_BIN, 'remember', `${nonce} wiring probe`],
        { cwd, env, encoding: 'utf-8' },
      );
      const rememberMatch = rememberOut.match(/Remembered \[(\S+)\]/);
      expect(rememberMatch).not.toBeNull();
      const localId = rememberMatch![1];

      // Ensures the local vector exists (deterministic, not racing remember's
      // own fire-and-forget embed) and warms the on-disk model cache before
      // promote runs.
      execFileSync('node', [HIPPO_BIN, 'embed'], { cwd, env, encoding: 'utf-8' });

      const promoteOut = execFileSync(
        'node',
        [HIPPO_BIN, 'promote', localId],
        { cwd, env, encoding: 'utf-8' },
      );
      const promoteMatch = promoteOut.match(/Promoted \S+ to global store as (\S+)/);
      expect(promoteMatch).not.toBeNull();
      const globalId = promoteMatch![1];
      expect(globalId).toMatch(/^g_/);

      if (isEmbeddingAvailable()) {
        // Bounded poll (<=60s): promoteToGlobal's embed fire is best-effort
        // fire-and-forget, but `execFileSync` only returns once the `promote`
        // subprocess has fully exited, and that process has no explicit
        // process.exit() call on the success path (cli.ts's main() returns
        // naturally), so Node's event loop keeps it alive until the floating
        // embedMemory promise settles — same reasoning as cmdImport's batch
        // embed comment (src/cli.ts:6086-6093). The poll is a safety margin,
        // not a requirement to wait out a race.
        await vi.waitFor(() => {
          const index = loadEmbeddingIndex(globalRoot);
          expect(index[globalId]).toBeDefined();
          expect(index[globalId].length).toBeGreaterThan(0);
        }, { timeout: 60_000, interval: 250 });
      }
    } finally {
      cleanUp(home, cwd);
    }
  }, 90_000);
});
