/**
 * L9 conflict-subsystem tenant-scoping tests (v1.12.1).
 *
 * 13 cases: 7 per-tenant negative (cross-tenant leak prevention) + 6
 * host-wide back-compat parity. Real DB per the project convention; multi-
 * tenant fixtures constructed via createMemory({ tenantId }).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry, loadAllEntries } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { invalidateMatching } from '../src/invalidation.js';
import { refineStore } from '../src/refine-llm.js';
import { deduplicateLesson } from '../src/autolearn.js';
import { cmdCapture } from '../src/capture.js';
// importEntries still used by case 6 for ImportOptions.tenantId path
import { importEntries } from '../src/importers.js';
import { autoShare } from '../src/shared.js';
import { consolidate } from '../src/consolidate.js';
import { listPeers, syncGlobalToLocal } from '../src/shared.js';
import { embedAll } from '../src/embeddings.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newRoot(prefix: string): { tmpDir: string; hippoRoot: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), prefix));
  const hippoRoot = join(tmpDir, '.hippo');
  initStore(hippoRoot);
  return { tmpDir, hippoRoot };
}

/**
 * Per-test HIPPO_HOME override to isolate any global-store writes (autoShare,
 * listPeers, syncGlobalToLocal call initGlobal()/getGlobalRoot()). Without
 * this the test mutates the run-wide isolated HIPPO_HOME baseline and
 * tests/_real-store-guard.ts trips on teardown.
 */
function tmpHippoHome(prefix: string): { home: string; restore: () => void } {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const orig = process.env.HIPPO_HOME;
  process.env.HIPPO_HOME = home;
  return {
    home,
    restore: () => {
      rmSync(home, { recursive: true, force: true });
      if (orig !== undefined) process.env.HIPPO_HOME = orig;
      else delete process.env.HIPPO_HOME;
    },
  };
}

function seedFor(
  hippoRoot: string,
  tenantId: string,
  content: string,
  opts: { tags?: string[]; pinned?: boolean; layer?: Layer } = {},
): string {
  const mem = createMemory(content, {
    layer: opts.layer ?? Layer.Episodic,
    tags: opts.tags ?? [],
    source: 'test',
    confidence: 'observed',
    baseHalfLifeDays: 30,
    tenantId,
  });
  if (opts.pinned) mem.pinned = true;
  writeEntry(hippoRoot, mem);
  return mem.id;
}

// ---------------------------------------------------------------------------
// 5a. Per-tenant negative tests (7 cases) — cross-tenant leak prevention
// ---------------------------------------------------------------------------

describe('L9: per-tenant scoping (cross-tenant leak prevention)', () => {
  let tmpDir: string;
  let hippoRoot: string;

  beforeEach(() => {
    ({ tmpDir, hippoRoot } = newRoot('hippo-l9-neg-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('case 1: invalidateMatching(..., tenant-a) does NOT weaken tenant-b matches', () => {
    seedFor(hippoRoot, 'tenant-a', 'REST API uses Bearer tokens', { tags: ['api'] });
    const bId = seedFor(hippoRoot, 'tenant-b', 'REST API documentation incomplete', { tags: ['docs'] });

    const result = invalidateMatching(
      hippoRoot,
      { from: 'REST', to: 'GraphQL', type: 'migration' },
      'tenant-a',
    );
    expect(result.invalidated).toBe(1);
    expect(result.targets).not.toContain(bId);

    // Verify tenant-b's entry is unchanged
    const bEntries = loadAllEntries(hippoRoot, 'tenant-b');
    expect(bEntries[0].confidence).toBe('observed');
    expect(bEntries[0].tags).not.toContain('invalidated');
  });

  it('case 2: refineStore(..., tenantId: tenant-a) does NOT scan tenant-b consolidated entries', async () => {
    // Seed a consolidated entry in tenant-b (would be refine candidate per CONSOLIDATED_MARKERS = '[Consolidated from' or '[Consolidated pattern from')
    seedFor(hippoRoot, 'tenant-b', '[Consolidated from 5 episodic memories] Common pattern for X', { tags: ['llm-consolidated'], layer: Layer.Semantic });
    // Seed plain entry in tenant-a (not a refine candidate, but proves the scope filter ran)
    seedFor(hippoRoot, 'tenant-a', 'unrelated content', {});

    // tenant-a scope: only tenant-a entries are returned by loadAllEntries,
    // and the tenant-a entry is not consolidated → scanned=0.
    const result = await refineStore(hippoRoot, {
      apiKey: 'test',
      tenantId: 'tenant-a',
      fetcher: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'refined' } }] }), { status: 200 }),
    });
    expect(result.scanned).toBe(0); // tenant-b's consolidated entry not visible

    // Positive control: host-wide scan does see the consolidated entry
    const hostWide = await refineStore(hippoRoot, {
      apiKey: 'test',
      fetcher: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'refined' } }] }), { status: 200 }),
      dryRun: true,
    });
    expect(hostWide.scanned).toBe(1);
  });

  it('case 3: refineStore parent lookup returns null for cross-tenant parents (graceful skip)', async () => {
    // Seed tenant-a consolidated entry whose parents JSON points to a tenant-b memory
    const bParentId = seedFor(hippoRoot, 'tenant-b', 'cross-tenant parent content', {});
    const consolidated = createMemory('[Consolidated from 2 episodic memories] merged pattern', {
      layer: Layer.Semantic,
      tags: ['llm-consolidated'],
      source: 'test',
      confidence: 'observed',
      baseHalfLifeDays: 30,
      tenantId: 'tenant-a',
    });
    consolidated.parents = [bParentId];
    writeEntry(hippoRoot, consolidated);

    // Sanity: confirm the consolidated entry is visible to a tenant-a scope
    const aOnly = loadAllEntries(hippoRoot, 'tenant-a');
    expect(aOnly.length).toBe(1);
    expect(aOnly[0].content.startsWith('[Consolidated from')).toBe(true);

    let refineCallSources: number | undefined;
    const fetcher = async (_url: string, init?: { body?: string }): Promise<Response> => {
      // Capture how many sources were sent to the LLM
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const userMsg = body.messages?.find((m: { role: string }) => m.role === 'user')?.content ?? '';
      refineCallSources = (userMsg.match(/Source \d/g) ?? []).length;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'refined output' } }] }),
        { status: 200 },
      );
    };

    const result = await refineStore(hippoRoot, {
      apiKey: 'test',
      tenantId: 'tenant-a',
      fetcher,
    });
    // L9 contract: the consolidated entry was scanned (scope=tenant-a hit),
    // and the parent lookup for the cross-tenant bParentId returned null →
    // refineSemanticMemory was called with 0 sources. The refined/failed
    // outcome depends on the test fetcher's OpenAI-shape parsing (not the
    // L9 contract), so we assert the scope and source-count only.
    expect(result.scanned).toBe(1);
    expect(refineCallSources).toBe(0); // cross-tenant parent was silently skipped
  });

  it('case 4: deduplicateLesson(root, ..., tenant-a) ignores tenant-b lessons', () => {
    seedFor(hippoRoot, 'tenant-b', 'use connection pooling for high QPS', { tags: ['lesson'] });

    // tenant-a sees no duplicates because tenant-b's lesson is invisible
    const isDup = deduplicateLesson(hippoRoot, 'use connection pooling for high QPS', 0.7, 'tenant-a');
    expect(isDup).toBe(false);

    // tenant-b would see it (positive control)
    const isDupB = deduplicateLesson(hippoRoot, 'use connection pooling for high QPS', 0.7, 'tenant-b');
    expect(isDupB).toBe(true);
  });

  it('case 5: cmdCapture (file source) dedup AND write are both tenant-scoped via options.tenantId', () => {
    // Use a fixture that actually triggers extractFromText.
    // 'we decided to X' matches DECISION_PATTERNS and extracts as a decision.
    const fixtureText = 'we decided to use Bearer tokens for HTTP authentication next quarter.';
    // The extracted content (post-regex-capture) is the post-pattern text:
    const extractedContent = 'use Bearer tokens for HTTP authentication next quarter';

    // Seed tenant-b with the SAME extracted content as a dedup-hit target
    seedFor(hippoRoot, 'tenant-b', extractedContent, { tags: ['decision'] });

    const fs = require('node:fs') as typeof import('node:fs');
    const fixturePath = join(tmpDir, 'capture-fixture.txt');
    fs.writeFileSync(fixturePath, fixtureText, 'utf8');

    // Sanity: tenant-b's view confirms seed; tenant-a's view is empty pre-capture.
    expect(loadAllEntries(hippoRoot, 'tenant-b').length).toBe(1);
    expect(loadAllEntries(hippoRoot, 'tenant-a').length).toBe(0);

    // Capture with tenant-a scope. The dedup branch in cmdCaptureCore calls
    // loadAllEntries(targetRoot, options.tenantId='tenant-a') and sees NOTHING
    // (tenant-b's seed is invisible), so the extracted decision IS written.
    cmdCapture(hippoRoot, {
      source: 'file',
      filePath: fixturePath,
      dryRun: false,
      global: false,
      tenantId: 'tenant-a',
    });

    // ASSERTION 1 (READ-side L9): the scoped dedup correctly missed,
    // so the captured entry was written into tenant-a.
    const aAfter = loadAllEntries(hippoRoot, 'tenant-a');
    expect(aAfter.length).toBe(1);
    expect(aAfter[0].content).toContain('Bearer tokens');

    // ASSERTION 2 (WRITE-side L9): the entry's tenant_id IS 'tenant-a',
    // not 'default'. This catches the scoped-dedup-passes-then-default-write
    // bug class (i.e. plumbing only the READ but not the WRITE).
    expect(aAfter[0].tenantId).toBe('tenant-a');

    // ASSERTION 3 (cross-tenant invariant): tenant-b unchanged.
    expect(loadAllEntries(hippoRoot, 'tenant-b').length).toBe(1);

    // ASSERTION 4 (host-wide negative control): a second capture without
    // tenantId on the same content would skip-as-duplicate (host-wide dedup
    // sees both tenant-a's and tenant-b's entries).
    const fixturePath2 = join(tmpDir, 'capture-fixture2.txt');
    fs.writeFileSync(fixturePath2, fixtureText, 'utf8');
    cmdCapture(hippoRoot, {
      source: 'file',
      filePath: fixturePath2,
      dryRun: false,
      global: false,
    });
    // No new entry. Total stays at 2 (tenant-a:1, tenant-b:1).
    expect(loadAllEntries(hippoRoot).length).toBe(2);
  });

  it('case 6: importEntries dedup AND write are both tenant-scoped via options.tenantId', () => {
    const content = 'session-based auth with httpOnly cookies';
    seedFor(hippoRoot, 'tenant-b', content, { tags: ['auth'] });

    // dryRun: false so the write path is exercised (symmetric to case 5).
    const result = importEntries(
      [content],
      'import:test',
      ['imported'],
      { hippoRoot, dryRun: false, tenantId: 'tenant-a', global: false },
    );
    // ASSERTION 1 (READ-side L9): tenant-a's import dedup misses tenant-b
    expect(result.entries.length).toBe(1);
    expect(result.imported).toBe(1);

    // ASSERTION 2 (WRITE-side L9): the imported entry IS in tenant-a's slice
    // with tenantId === 'tenant-a' (NOT 'default'). Catches the same
    // scoped-dedup-then-default-write bug class case 5 catches for capture.
    const aAfter = loadAllEntries(hippoRoot, 'tenant-a');
    expect(aAfter.length).toBe(1);
    expect(aAfter[0].tenantId).toBe('tenant-a');
    expect(aAfter[0].content).toBe(content);

    // ASSERTION 3 (cross-tenant invariant): tenant-b unchanged.
    expect(loadAllEntries(hippoRoot, 'tenant-b').length).toBe(1);

    // ASSERTION 4 (host-wide negative control): a host-wide import (no
    // tenantId) of the same content would skip-as-duplicate.
    const result2 = importEntries(
      [content],
      'import:test',
      ['imported'],
      { hippoRoot, dryRun: false, global: false },
    );
    expect(result2.imported).toBe(0);
    expect(loadAllEntries(hippoRoot).length).toBe(2); // tenant-a:1, tenant-b:1
  });

  it('case 7: autoShare({ tenantId: tenant-a }) only considers tenant-a local memories', () => {
    const isolated = tmpHippoHome('hippo-l9-autoShare-global-');
    try {
      // Seed both tenants with high-transfer-score content (with the 'lesson' tag boost)
      seedFor(hippoRoot, 'tenant-a', 'a-lesson: prefer explicit imports over wildcards', { tags: ['lesson', 'global-relevant'] });
      seedFor(hippoRoot, 'tenant-b', 'b-lesson: do not commit secrets to git', { tags: ['lesson', 'global-relevant'] });

      // dryRun returns the candidate list without writing
      const candidates = autoShare(hippoRoot, { tenantId: 'tenant-a', minScore: 0, dryRun: true });
      // Only tenant-a candidates should appear
      const contents = candidates.map((c) => c.content);
      expect(contents.some((c) => c.startsWith('a-lesson:'))).toBe(true);
      expect(contents.some((c) => c.startsWith('b-lesson:'))).toBe(false);
    } finally {
      isolated.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// 5b. Host-wide back-compat parity tests (6 cases) — current behaviour preserved
// ---------------------------------------------------------------------------

describe('L9: host-wide back-compat parity (current behaviour preserved)', () => {
  let tmpDir: string;
  let hippoRoot: string;

  beforeEach(() => {
    ({ tmpDir, hippoRoot } = newRoot('hippo-l9-pos-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('case 8: invalidateMatching(...) without tenantId weakens all tenants (host-wide)', () => {
    seedFor(hippoRoot, 'tenant-a', 'REST API uses Bearer tokens', { tags: ['api'] });
    seedFor(hippoRoot, 'tenant-b', 'REST API documentation incomplete', { tags: ['docs'] });

    // No tenantId arg → host-wide behaviour (current/pre-1.12.1)
    const result = invalidateMatching(hippoRoot, { from: 'REST', to: 'GraphQL', type: 'migration' });
    expect(result.invalidated).toBe(2);
  });

  it('case 9: refineStore({}) without tenantId scans all tenants consolidated entries', async () => {
    seedFor(hippoRoot, 'tenant-a', '[Consolidated from 3 episodic memories] pattern X', { tags: ['llm-consolidated'], layer: Layer.Semantic });
    seedFor(hippoRoot, 'tenant-b', '[Consolidated from 4 episodic memories] pattern Y', { tags: ['llm-consolidated'], layer: Layer.Semantic });

    // Sanity: confirm both entries are visible to host-wide loadAllEntries
    const allHostWide = loadAllEntries(hippoRoot);
    expect(allHostWide.length).toBe(2);
    expect(allHostWide.every((e) => e.content.startsWith('[Consolidated from'))).toBe(true);

    const result = await refineStore(hippoRoot, {
      apiKey: 'test',
      fetcher: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'refined' } }] }), { status: 200 }),
      dryRun: true,
    });
    // Both tenants' consolidated entries are scanned (host-wide). The
    // exact refined/failed split depends on refineSemanticMemory's response
    // parsing; the host-wide assertion is on `scanned`.
    expect(result.scanned).toBe(2);
  });

  it('case 10: consolidate runs across all tenants (signature/contract test)', async () => {
    // Signature/contract test, same shape as case 11. The L9 JSDoc at
    // consolidate.ts:106 locks the host-wide intent; this test asserts that
    // the exact reader call shape consolidate uses (loadAllEntries(hippoRoot)
    // with no tenantId) returns both tenants' entries. A future PR that adds
    // tenant scoping to consolidate's internal reader would not directly fail
    // this test — it would fail at the JSDoc-review step and break the
    // documented contract. Genuine end-to-end coverage of consolidate's
    // internal reader behaviour would require asserting on consolidation
    // side-effects across both tenants (decay, dedup, extraction), which
    // depends on decay timing that this test doesn't control. The L9
    // assertion is the reader-shape contract.
    seedFor(hippoRoot, 'tenant-a', 'tenant-a episodic memory', {});
    seedFor(hippoRoot, 'tenant-b', 'tenant-b episodic memory', {});

    await consolidate(hippoRoot, { dryRun: true });

    // Reader-shape contract: host-wide reader returns both tenants.
    const all = loadAllEntries(hippoRoot);
    expect(all.length).toBe(2);
    expect(all.map((e) => e.tenantId).sort()).toEqual(['tenant-a', 'tenant-b']);
  });

  it('case 11: host-wide reader semantics for embeddings.ts (signature-only test)', async () => {
    // embedAll + embedMemory rebuild paths require OPENAI_API_KEY to exercise
    // the actual loadAllEntries(hippoRoot) inside withEmbedLock. In a unit-test
    // env without the API key, embedAll short-circuits at isEmbeddingAvailable.
    // This test therefore asserts the host-wide CONTRACT at the signature/reader
    // level: a host-wide loadAllEntries(hippoRoot) call (the exact one embedAll
    // and embedMemory's rebuild branch make) returns ALL tenants' entries —
    // which is the property the rebuild branches rely on.
    seedFor(hippoRoot, 'tenant-a', 'tenant-a memory for embed', {});
    seedFor(hippoRoot, 'tenant-b', 'tenant-b memory for embed', {});

    // Side-effect: confirms embedAll returns a non-negative number without throw.
    // (When OPENAI_API_KEY is unset this is 0; when set it would do the rebuild.)
    const count = await embedAll(hippoRoot);
    expect(count).toBeGreaterThanOrEqual(0);

    // The contract assertion: the exact reader call shape embedAll +
    // embedMemory's rebuild branch use is host-wide (no tenantId arg) and
    // returns both tenants. A future refactor that adds tenant filtering to
    // this exact call shape would fail here and require the L9 JSDoc to be
    // re-evaluated.
    const hostWideRead = loadAllEntries(hippoRoot);
    expect(hostWideRead.length).toBe(2);
    expect(hostWideRead.map((e) => e.tenantId).sort()).toEqual(['tenant-a', 'tenant-b']);
  });

  it('case 12: listPeers aggregates across all tenants regardless of source-tenant', () => {
    // listPeers is on the GLOBAL store, not the per-project local. We seed the
    // local root with shared:project-foo: + shared:project-bar: source strings
    // (these would normally land in global after auto-share but the parsing
    // logic listPeers uses only cares about source string format).
    const a = createMemory('shared from project foo', {
      layer: Layer.Episodic,
      tags: [],
      source: 'shared:project-foo:abc',
      confidence: 'observed',
      baseHalfLifeDays: 30,
      tenantId: 'tenant-a',
    });
    writeEntry(hippoRoot, a);
    const b = createMemory('shared from project bar', {
      layer: Layer.Episodic,
      tags: [],
      source: 'shared:project-bar:xyz',
      confidence: 'observed',
      baseHalfLifeDays: 30,
      tenantId: 'tenant-b',
    });
    writeEntry(hippoRoot, b);

    // Both tenants' shared entries surface as peers (host-wide aggregation)
    const peers = listPeers(hippoRoot);
    const peerNames = peers.map((p) => p.project);
    expect(peerNames).toContain('project-foo');
    expect(peerNames).toContain('project-bar');
  });

  it('case 13: syncGlobalToLocal host-wide TENANT read survives the v39 origin gate', () => {
    // syncGlobalToLocal doesn't call initGlobal() (caller provides the
    // globalRoot directly), so HIPPO_HOME isolation isn't strictly required
    // here — but kept consistent for defence-in-depth.
    const isolated = tmpHippoHome('hippo-l9-sync-global-');
    try {
      // Set up two separate roots to simulate global → local sync
      const { tmpDir: globalTmp, hippoRoot: globalRoot } = newRoot('hippo-l9-global-');
      try {
        // Seed global with two tenants' worth of entries. Under v39 they
        // are stamped with the seed store's own (different) project origin,
        // so the default sync gates them as cross-project...
        seedFor(globalRoot, 'tenant-a', 'global memory from tenant-a', {});
        seedFor(globalRoot, 'tenant-b', 'global memory from tenant-b', {});

        expect(syncGlobalToLocal(hippoRoot, globalRoot)).toBe(0);

        // ...but this case's original guarantee - the global read is
        // host-wide across TENANTS - still holds once the origin gate is
        // explicitly lifted: both tenants' rows copy.
        const copied = syncGlobalToLocal(hippoRoot, globalRoot, { includeCrossProject: true });
        expect(copied).toBe(2);
      } finally {
        rmSync(globalTmp, { recursive: true, force: true });
      }
    } finally {
      isolated.restore();
    }
  });
});

describe('L9 + invalidate onlyId (2026-06-09 safety fix)', () => {
  let tmpDir: string;
  let hippoRoot: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hippo-l9-onlyid-'));
    hippoRoot = join(tmpDir, '.hippo');
    initStore(hippoRoot);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('onlyId naming a tenant-B memory under tenant-A scope invalidates nothing', () => {
    const bId = seedFor(hippoRoot, 'tenant-b', 'tenant B private memory', { tags: ['private'] });

    const result = invalidateMatching(
      hippoRoot,
      { from: `id:${bId}`, to: null, type: 'removal' },
      'tenant-a',
      { onlyId: bId },
    );

    expect(result.invalidated).toBe(0);
    expect(result.targets).toEqual([]);
    // tenant-b's entry is untouched
    const bEntries = loadAllEntries(hippoRoot, 'tenant-b');
    expect(bEntries[0].confidence).toBe('observed');
    expect(bEntries[0].tags).not.toContain('invalidated');
  });
});
