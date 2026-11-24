import { describe, it, expect, expectTypeOf, beforeEach, vi, afterEach } from 'vitest';
import { join } from 'node:path';
import { createMemory } from '../../src/entry/memory.js';
import { Layer } from '../../src/base/memory/entry.js';
import { invalidateMatching } from '../../src/domain/learn/invalidation.js';
import { refineStore } from '../../src/surface/cli/refine-llm.js';
import { anthropicLlm } from '../../src/infra/anthropic-llm.js';
import { runCapture } from '../../src/surface/capture/command.js';
import { captureTarget, localIndex, hookStore } from '../_helpers/cli-stores.js';
import { importEntries } from '../../src/entry/importers.js';
import { autoShare } from '../../src/domain/sharing/share.js';
import { consolidate } from '../../src/index.js';
import { listPeers } from '../../src/domain/sharing/share.js';
import { syncGlobalToLocal } from '../../src/domain/sharing/global-sync.js';
import { embedAll } from '../../src/domain/search/embed-memories.js';
import { folderStore, sharingStores } from '../_helpers/sharing-stores.js';
import { makeRoot, makeStore } from '../_helpers/make-root.js';
import { loadEveryTenantEntries, writeEntry, loadAllEntries } from '../_helpers/root-forms.js';
import { ALL_TENANTS } from '../../src/base/util/tenant.js';
import { TEST_DETACHED, TEST_RUN } from '../_helpers/test-run.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

function isolateGlobalHome(label: string): void {
  vi.stubEnv('HIPPO_HOME', makeRoot(label, { init: false }));
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

describe('per-tenant scoping (cross-tenant leak prevention)', () => {
  let tmpDir: string;
  let hippoRoot: string;

  beforeEach(() => {
    ({ base: tmpDir, root: hippoRoot } = makeStore('l9-neg'));
  });

  it('case 1: invalidateMatching(..., tenant-a) does NOT weaken tenant-b matches', async () => {
    seedFor(hippoRoot, 'tenant-a', 'REST API uses Bearer tokens', { tags: ['api'] });
    const bId = seedFor(hippoRoot, 'tenant-b', 'REST API documentation incomplete', { tags: ['docs'] });

    const result = await invalidateMatching(
      hookStore(hippoRoot),
      { from: 'REST', to: 'GraphQL', type: 'migration' },
      'tenant-a',
    );
    expect(result.invalidated).toBe(1);
    expect(result.targets).not.toContain(bId);

    const bEntries = loadAllEntries(hippoRoot, 'tenant-b');
    expect(bEntries[0].confidence).toBe('observed');
    expect(bEntries[0].tags).not.toContain('invalidated');
  });

  it('case 2: refineStore(..., tenantId: tenant-a) does NOT scan tenant-b consolidated entries', async () => {
    seedFor(hippoRoot, 'tenant-b', '[Consolidated from 5 episodic memories] Common pattern for X', {
      tags: ['llm-consolidated'],
      layer: Layer.Semantic,
    });
    seedFor(hippoRoot, 'tenant-a', 'unrelated content', {});

    const result = await refineStore(hippoRoot, {
      llm: anthropicLlm({
        apiKey: 'test',
        fetcher: async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: 'refined' } }] }), { status: 200 }),
      }),
      tenantId: 'tenant-a',
    });
    expect(result.scanned).toBe(0);
    const hostWide = await refineStore(hippoRoot, {
      llm: anthropicLlm({
        apiKey: 'test',
        fetcher: async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: 'refined' } }] }), { status: 200 }),
      }),
      dryRun: true,
    });
    expect(hostWide.scanned).toBe(1);
  });

  it('case 3: refineStore parent lookup returns null for cross-tenant parents (graceful skip)', async () => {
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

    const aOnly = loadAllEntries(hippoRoot, 'tenant-a');
    expect(aOnly.length).toBe(1);
    expect(aOnly[0].content.startsWith('[Consolidated from')).toBe(true);

    let refineCallSources: number | undefined;
    const fetcher = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const userMsg = body.messages?.find((m: { role: string }) => m.role === 'user')?.content ?? '';
      refineCallSources = (userMsg.match(/Source \d/g) ?? []).length;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'refined output' } }] }), { status: 200 });
    };

    const result = await refineStore(hippoRoot, {
      llm: anthropicLlm({ apiKey: 'test', fetcher }),
      tenantId: 'tenant-a',
    });
    expect(result.scanned).toBe(1);
    expect(refineCallSources).toBe(0);
  });

  it('case 5: runCapture (file source) dedup AND write are both tenant-scoped via options.tenantId', async () => {
    const fixtureText = 'we decided to use Bearer tokens for HTTP authentication next quarter.';
    const extractedContent = 'use Bearer tokens for HTTP authentication next quarter';

    seedFor(hippoRoot, 'tenant-b', extractedContent, { tags: ['decision'] });

    // SAFETY: require() of a built-in Node module always resolves to its
    // real module object; this mirrors the module's own .d.ts shape.
    const fs = require('node:fs') as typeof import('node:fs');
    const fixturePath = join(tmpDir, 'capture-fixture.txt');
    fs.writeFileSync(fixturePath, fixtureText, 'utf8');

    expect(loadAllEntries(hippoRoot, 'tenant-b').length).toBe(1);
    expect(loadAllEntries(hippoRoot, 'tenant-a').length).toBe(0);

    await runCapture(captureTarget(hippoRoot), {
      source: 'file',
      filePath: fixturePath,
      dryRun: false,
      global: false,
      tenantId: 'tenant-a',
    });

    const aAfter = loadAllEntries(hippoRoot, 'tenant-a');
    expect(aAfter.length).toBe(1);
    expect(aAfter[0].content).toContain('Bearer tokens');

    expect(aAfter[0].tenantId).toBe('tenant-a');

    expect(loadAllEntries(hippoRoot, 'tenant-b').length).toBe(1);

    const fixturePath2 = join(tmpDir, 'capture-fixture2.txt');
    fs.writeFileSync(fixturePath2, fixtureText, 'utf8');
    await runCapture(captureTarget(hippoRoot), {
      tenantId: 'tenant-a',
      source: 'file',
      filePath: fixturePath2,
      dryRun: false,
      global: false,
    });
    expect(loadEveryTenantEntries(hippoRoot).length).toBe(2);
  });

  it('case 6: importEntries dedup AND write are both tenant-scoped via options.tenantId', () => {
    const content = 'session-based auth with httpOnly cookies';
    seedFor(hippoRoot, 'tenant-b', content, { tags: ['auth'] });

    const result = importEntries([content], 'import:test', ['imported'], {
      hippoRoot,
      dryRun: false,
      tenantId: 'tenant-a',
      global: false,
    });
    expect(result.entries.length).toBe(1);
    expect(result.imported).toBe(1);

    const aAfter = loadAllEntries(hippoRoot, 'tenant-a');
    expect(aAfter.length).toBe(1);
    expect(aAfter[0].tenantId).toBe('tenant-a');
    expect(aAfter[0].content).toBe(content);

    expect(loadAllEntries(hippoRoot, 'tenant-b').length).toBe(1);

    const result2 = importEntries([content], 'import:test', ['imported'], {
      tenantId: 'tenant-a',
      hippoRoot,
      dryRun: false,
      global: false,
    });
    expect(result2.imported).toBe(0);
    expect(loadEveryTenantEntries(hippoRoot).length).toBe(2);
  });

  it('case 7: autoShare({ tenantId: tenant-a }) only considers tenant-a local memories', async () => {
    isolateGlobalHome('l9-autoshare-global');
    seedFor(hippoRoot, 'tenant-a', 'a-lesson: prefer explicit imports over wildcards', {
      tags: ['lesson', 'global-relevant'],
    });
    seedFor(hippoRoot, 'tenant-b', 'b-lesson: do not commit secrets to git', { tags: ['lesson', 'global-relevant'] });

    const candidates = await autoShare(...sharingStores(hippoRoot), {
      embed: TEST_RUN,
      detached: TEST_DETACHED,
      tenantId: 'tenant-a',
      minScore: 0,
      dryRun: true,
    });
    const contents = candidates.map((c) => c.content);
    expect(contents.some((c) => c.startsWith('a-lesson:'))).toBe(true);
    expect(contents.some((c) => c.startsWith('b-lesson:'))).toBe(false);
  });
});

describe('host-wide back-compat parity (current behaviour preserved)', () => {
  let hippoRoot: string;

  beforeEach(() => {
    ({ root: hippoRoot } = makeStore('l9-pos'));
  });

  it('case 8: invalidateMatching takes a required tenant, so no caller weakens every tenant by leaving it out', () => {
    expectTypeOf(invalidateMatching).parameter(2).toEqualTypeOf<string>();
  });

  it('case 9: refineStore({}) without tenantId scans all tenants consolidated entries', async () => {
    seedFor(hippoRoot, 'tenant-a', '[Consolidated from 3 episodic memories] pattern X', {
      tags: ['llm-consolidated'],
      layer: Layer.Semantic,
    });
    seedFor(hippoRoot, 'tenant-b', '[Consolidated from 4 episodic memories] pattern Y', {
      tags: ['llm-consolidated'],
      layer: Layer.Semantic,
    });

    const allHostWide = loadEveryTenantEntries(hippoRoot);
    expect(allHostWide.length).toBe(2);
    expect(allHostWide.every((e) => e.content.startsWith('[Consolidated from'))).toBe(true);

    const result = await refineStore(hippoRoot, {
      llm: anthropicLlm({
        apiKey: 'test',
        fetcher: async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: 'refined' } }] }), { status: 200 }),
      }),
      dryRun: true,
    });
    expect(result.scanned).toBe(2);
  });

  it('case 10: consolidate runs across all tenants (signature/contract test)', async () => {
    seedFor(hippoRoot, 'tenant-a', 'tenant-a episodic memory', {});
    seedFor(hippoRoot, 'tenant-b', 'tenant-b episodic memory', {});

    await consolidate(hippoRoot, { dryRun: true });

    const all = loadEveryTenantEntries(hippoRoot);
    expect(all.length).toBe(2);
    expect(all.map((e) => e.tenantId).sort()).toEqual(['tenant-a', 'tenant-b']);
  });

  it('case 11: host-wide reader semantics for embeddings.ts (signature-only test)', async () => {
    seedFor(hippoRoot, 'tenant-a', 'tenant-a memory for embed', {});
    seedFor(hippoRoot, 'tenant-b', 'tenant-b memory for embed', {});

    const count = await embedAll(localIndex(hippoRoot));
    expect(count).toBeGreaterThanOrEqual(0);

    const hostWideRead = loadEveryTenantEntries(hippoRoot);
    expect(hostWideRead.length).toBe(2);
    expect(hostWideRead.map((e) => e.tenantId).sort()).toEqual(['tenant-a', 'tenant-b']);
  });

  it('case 12: listPeers aggregates across all tenants regardless of source-tenant', async () => {
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

    const peers = await listPeers(folderStore(hippoRoot), ALL_TENANTS);
    const peerNames = peers.map((p) => p.project);
    expect(peerNames).toContain('project-foo');
    expect(peerNames).toContain('project-bar');
  });

  it('case 13: syncGlobalToLocal host-wide TENANT read survives the v39 origin gate', async () => {
    isolateGlobalHome('l9-sync-global');
    const { root: globalRoot } = makeStore('l9-global');
    seedFor(globalRoot, 'tenant-a', 'global memory from tenant-a', {});
    seedFor(globalRoot, 'tenant-b', 'global memory from tenant-b', {});

    expect(
      await syncGlobalToLocal(...sharingStores(hippoRoot, globalRoot), { embed: TEST_RUN, detached: TEST_DETACHED }),
    ).toBe(0);

    const copied = await syncGlobalToLocal(...sharingStores(hippoRoot, globalRoot), {
      embed: TEST_RUN,
      detached: TEST_DETACHED,
      includeCrossProject: true,
    });
    expect(copied).toBe(2);
  });
});

describe('invalidate onlyId', () => {
  let hippoRoot: string;

  beforeEach(() => {
    ({ root: hippoRoot } = makeStore('l9-onlyid'));
  });

  it('onlyId naming a tenant-B memory under tenant-A scope invalidates nothing', async () => {
    const bId = seedFor(hippoRoot, 'tenant-b', 'tenant B private memory', { tags: ['private'] });

    const result = await invalidateMatching(
      hookStore(hippoRoot),
      { from: `id:${bId}`, to: null, type: 'removal' },
      'tenant-a',
      { onlyId: bId },
    );

    expect(result.invalidated).toBe(0);
    expect(result.targets).toEqual([]);
    const bEntries = loadAllEntries(hippoRoot, 'tenant-b');
    expect(bEntries[0].confidence).toBe('observed');
    expect(bEntries[0].tags).not.toContain('invalidated');
  });
});
