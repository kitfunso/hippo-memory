/**
 * v0.30 / E5 of DAG live-coupling — level-3 entity profiles + drillDown depth.
 *
 * Locks: buildEntityProfiles L2->L3 aggregation, born-dirty cancellation on
 * L3, widened dag_level guards (markSummaryDirtyInTx + applyRebuildResult +
 * clearSummaryDirtyAfterBuild all handle L2+L3 uniformly), audit metadata
 * reads actual level (NOT hardcoded), drillDown depth N + visited Set dedup
 * + totalChildren semantics + tenant isolation per level, isDagSummary
 * widened to L2+L3 with E4 deboost still firing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore, writeEntry, loadAllL2Summaries } from '../src/store.js';
import { openHippoDb } from '../src/db.js';
import { createMemory, Layer, type MemoryEntry } from '../src/memory.js';
import {
  buildEntityProfiles,
  rebuildDirtySummaries,
} from '../src/dag.js';
import { drillDown, type Context, type DrillDownResult } from '../src/api.js';
import { hybridSearch, isDagSummary } from '../src/search.js';

function makeOkFetcher(content: string = 'synthetic-entity-profile-content-xyz') {
  return vi.fn(async () => {
    return new Response(
      JSON.stringify({ content: [{ text: content }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
}

function makeL2Summary(
  content: string,
  speaker: string = 'alice',
  parentId?: string | null,
): MemoryEntry {
  const s = createMemory(content, {
    layer: Layer.Semantic,
    tags: [`speaker:${speaker}`, 'dag-summary'],
    confidence: 'inferred',
    dag_level: 2,
  });
  if (parentId !== undefined) s.dag_parent_id = parentId ?? undefined;
  return s;
}

function makeL3Profile(content: string, speaker: string = 'alice'): MemoryEntry {
  const s = createMemory(content, {
    layer: Layer.Semantic,
    tags: [`speaker:${speaker}`, 'dag-entity-profile'],
    confidence: 'inferred',
    dag_level: 3,
  });
  return s;
}

function makeL1Fact(parentId: string, content: string): MemoryEntry {
  const c = createMemory(content, {
    layer: Layer.Episodic,
    tags: ['extracted'],
    dag_level: 1,
    dag_parent_id: parentId,
  });
  return c;
}

function forceMarkDirty(hippoRoot: string, summaryId: string): void {
  const db = openHippoDb(hippoRoot);
  try {
    db.prepare(`UPDATE memories SET summary_dirty = 1 WHERE id = ?`).run(summaryId);
  } finally {
    db.close();
  }
}

function defaultCtx(hippoRoot: string, tenantId: string = 'default'): Context {
  return {
    hippoRoot,
    tenantId,
    actor: { subject: 'test:e5', role: 'admin' },
  };
}

describe('v0.30 / E5 — level-3 entity profiles + drillDown depth', () => {
  let hippoRoot: string;

  beforeEach(() => {
    hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-dag-e5-'));
    initStore(hippoRoot);
  });

  afterEach(() => {
    fs.rmSync(hippoRoot, { recursive: true, force: true });
  });

  it('test #1: buildEntityProfiles happy path — 3 L2 summaries -> 1 L3 profile', async () => {
    const l2a = makeL2Summary('alice prefers python type hints', 'alice');
    const l2b = makeL2Summary('alice ships features in 2-week cycles', 'alice');
    const l2c = makeL2Summary('alice owns the API layer', 'alice');
    [l2a, l2b, l2c].forEach((e) => writeEntry(hippoRoot, e));

    const fetcher = makeOkFetcher('synthetic-alice-entity-profile-content-zzz');
    const result = await buildEntityProfiles(hippoRoot, [l2a, l2b, l2c], {
      apiKey: 'test-key',
      fetcher,
    });

    expect(result.profilesCreated).toBe(1);
    expect(result.l2sLinked).toBe(3);
    expect(result.candidateClusters).toBe(1);

    const db = openHippoDb(hippoRoot);
    try {
      const profile = db.prepare(`
        SELECT id, content, dag_level, dag_level_3_built_at, descendant_count, earliest_at, latest_at
          FROM memories WHERE dag_level = 3
      `).get() as any;
      expect(profile).toBeTruthy();
      expect(profile.dag_level).toBe(3);
      expect(profile.dag_level_3_built_at).toBeTruthy();
      expect(profile.descendant_count).toBe(3);
      expect(profile.earliest_at).toBeTruthy();
      expect(profile.latest_at).toBeTruthy();

      // All 3 L2s now have dag_parent_id pointing to profile
      const linkedRows = db.prepare(`SELECT id FROM memories WHERE dag_parent_id = ?`).all(profile.id) as any[];
      expect(linkedRows.length).toBe(3);
    } finally {
      db.close();
    }
  });

  it('test #2: no clustering below threshold — 1 L2 summary -> 0 profiles', async () => {
    const l2 = makeL2Summary('alone fact content', 'alice');
    writeEntry(hippoRoot, l2);
    const result = await buildEntityProfiles(hippoRoot, [l2], {
      apiKey: 'k',
      fetcher: makeOkFetcher(),
    });
    expect(result.profilesCreated).toBe(0);
    expect(result.candidateClusters).toBe(0);
  });

  it('test #3: skips L2s with existing L3 parent', async () => {
    const existing = makeL3Profile('existing alice profile content', 'alice');
    writeEntry(hippoRoot, existing);
    const parented = makeL2Summary('already linked alice topic', 'alice', existing.id);
    const unparented1 = makeL2Summary('unlinked alice topic one', 'alice');
    const unparented2 = makeL2Summary('unlinked alice topic two', 'alice');
    [parented, unparented1, unparented2].forEach((e) => writeEntry(hippoRoot, e));

    const result = await buildEntityProfiles(hippoRoot, [parented, unparented1, unparented2], {
      apiKey: 'k',
      fetcher: makeOkFetcher(),
    });
    // Only the 2 unparented ones cluster
    expect(result.l2sLinked).toBe(2);
    // M2 fold: confirm the parented L2 STILL points at `existing`, not the new L3.
    const db = openHippoDb(hippoRoot);
    try {
      const row = db.prepare(`SELECT dag_parent_id FROM memories WHERE id = ?`).get(parented.id) as any;
      expect(row.dag_parent_id).toBe(existing.id);
    } finally {
      db.close();
    }
  });

  it('test #4: L3 born-dirty cancellation — summary_dirty=0 after build + audit source=buildEntityProfiles-clean', async () => {
    const l2a = makeL2Summary('alice topic one for clean test', 'alice');
    const l2b = makeL2Summary('alice topic two for clean test', 'alice');
    writeEntry(hippoRoot, l2a);
    writeEntry(hippoRoot, l2b);

    await buildEntityProfiles(hippoRoot, [l2a, l2b], {
      apiKey: 'k',
      fetcher: makeOkFetcher('alice-clean-profile-content-zzz'),
    });

    const db = openHippoDb(hippoRoot);
    try {
      const profile = db.prepare(`SELECT id, summary_dirty FROM memories WHERE dag_level = 3`).get() as any;
      expect(profile.summary_dirty).toBe(0);

      const cleanRows = db.prepare(`
        SELECT metadata_json FROM audit_log WHERE op = 'summary_marked_clean' AND target_id = ?
      `).all(profile.id) as Array<{ metadata_json: string }>;
      expect(cleanRows.length).toBeGreaterThan(0);
      const meta = JSON.parse(cleanRows[0].metadata_json);
      expect(meta.source).toBe('buildEntityProfiles-clean');
      expect(meta.dag_level).toBe(3); // H1 fold: read actual level, NOT hardcoded 2
    } finally {
      db.close();
    }
  });

  it('test #5: markSummaryDirtyInTx widened to L3 — write L2 with dag_parent_id=L3 marks L3 dirty', () => {
    const l3 = makeL3Profile('alice existing profile content', 'alice');
    writeEntry(hippoRoot, l3);
    const db1 = openHippoDb(hippoRoot);
    db1.prepare(`UPDATE memories SET summary_dirty = 0 WHERE id = ?`).run(l3.id);
    db1.close();

    // Write a NEW L2 with dag_parent_id pointing to the L3 -> E2 hook fires.
    const newL2 = makeL2Summary('new alice topic', 'alice', l3.id);
    writeEntry(hippoRoot, newL2);

    const db = openHippoDb(hippoRoot);
    try {
      const row = db.prepare(`SELECT summary_dirty FROM memories WHERE id = ?`).get(l3.id) as any;
      expect(row.summary_dirty).toBe(1);

      const auditRows = db.prepare(`
        SELECT metadata_json FROM audit_log WHERE op = 'summary_marked_dirty' AND target_id = ?
      `).all(l3.id) as Array<{ metadata_json: string }>;
      expect(auditRows.length).toBeGreaterThan(0);
      const meta = JSON.parse(auditRows[0].metadata_json);
      expect(meta.dag_level).toBe(3); // H1 fold: actual level
    } finally {
      db.close();
    }
  });

  it('test #6: rebuildDirtySummaries handles dirty L3 (label derivation + dag_level_3_built_at preserved)', async () => {
    const l3 = makeL3Profile('old alice profile content xxx', 'alice');
    const builtAtIso = '2026-01-01T00:00:00.000Z';
    l3.dag_level_3_built_at = builtAtIso;
    writeEntry(hippoRoot, l3);
    // Add a child L2 so rebuild has children to read
    const childL2 = makeL2Summary('alice topic for rebuild test', 'alice', l3.id);
    writeEntry(hippoRoot, childL2);
    forceMarkDirty(hippoRoot, l3.id);

    let capturedPrompt: string | undefined;
    const fetcher = vi.fn(async (_url: any, init?: any) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      capturedPrompt = body?.messages?.[0]?.content ?? '';
      return new Response(
        JSON.stringify({ content: [{ text: 'rebuilt-alice-profile-content-yyy' }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await rebuildDirtySummaries(hippoRoot, {
      apiKey: 'k',
      fetcher,
      cap: 20,
    });
    expect(result.rebuilt).toBe(1);

    const db = openHippoDb(hippoRoot);
    try {
      const row = db.prepare(`
        SELECT content, rebuild_count, last_rebuilt_at, summary_dirty, dag_level_3_built_at
          FROM memories WHERE id = ?
      `).get(l3.id) as any;
      expect(row.content).toBe('rebuilt-alice-profile-content-yyy');
      expect(row.rebuild_count).toBe(1);
      expect(row.last_rebuilt_at).toBeTruthy();
      expect(row.summary_dirty).toBe(0);
      // dag_level_3_built_at UNCHANGED (set once at create, not bumped on rebuild)
      expect(row.dag_level_3_built_at).toBe(builtAtIso);

      // Audit row has dag_level: 3 in metadata (NOT hardcoded 2)
      const auditRow = db.prepare(`
        SELECT metadata_json FROM audit_log WHERE op = 'summary_rebuilt' AND target_id = ?
      `).get(l3.id) as any;
      expect(auditRow).toBeTruthy();
      const meta = JSON.parse(auditRow.metadata_json);
      expect(meta.dag_level).toBe(3);
      expect(meta.source).toBe('E3-rebuild');
    } finally {
      db.close();
    }
    // Label derivation: prompt contains the speaker:alice tag's value 'alice'
    expect(capturedPrompt).toContain('alice');
  });

  it('test #7: drillDown depth=1 backward compat — returns immediate children', () => {
    const summary = makeL2Summary('compat test summary content', 'alice');
    writeEntry(hippoRoot, summary);
    writeEntry(hippoRoot, makeL1Fact(summary.id, 'fact one for compat test'));
    writeEntry(hippoRoot, makeL1Fact(summary.id, 'fact two for compat test'));

    const r = drillDown(defaultCtx(hippoRoot), summary.id) as DrillDownResult;
    expect('failure' in r).toBe(false);
    expect(r.children.length).toBe(2);
    expect(r.totalChildren).toBe(2);
  });

  it('normalizes a fractional API depth before walking the DAG', () => {
    const l3 = makeL3Profile('fractional depth profile', 'alice');
    writeEntry(hippoRoot, l3);
    const l2 = makeL2Summary('fractional depth topic', 'alice', l3.id);
    writeEntry(hippoRoot, l2);
    writeEntry(hippoRoot, makeL1Fact(l2.id, 'fractional depth leaf'));

    const r = drillDown(defaultCtx(hippoRoot), l3.id, { depth: 1.5 }) as DrillDownResult;
    expect(r.children.map((child) => child.id)).toEqual([l2.id]);
  });

  it('test #8: drillDown depth=2 from L3 returns L2s + L1s with dedup + totalChildren=8', () => {
    const l3 = makeL3Profile('alice profile for depth test', 'alice');
    l3.descendant_count = 2; // stored direct-child count (2 L2 kids)
    writeEntry(hippoRoot, l3);
    const l2a = makeL2Summary('alice topic A for depth', 'alice', l3.id);
    const l2b = makeL2Summary('alice topic B for depth', 'alice', l3.id);
    writeEntry(hippoRoot, l2a);
    writeEntry(hippoRoot, l2b);
    for (let i = 0; i < 3; i++) {
      writeEntry(hippoRoot, makeL1Fact(l2a.id, `A-fact-${i} content here`));
      writeEntry(hippoRoot, makeL1Fact(l2b.id, `B-fact-${i} content here`));
    }

    const r = drillDown(defaultCtx(hippoRoot), l3.id, { depth: 2 }) as DrillDownResult;
    expect('failure' in r).toBe(false);
    // 2 L2s + 6 L1s = 8 entries
    expect(r.children.length).toBe(8);
    expect(r.totalChildren).toBe(8);
    // descendantCount stays at the L3's stored value (2 L2 direct children)
    expect(r.summary.descendantCount).toBe(2);
    // All returned ids unique (visited Set dedup lock)
    const ids = new Set(r.children.map((c) => c.id));
    expect(ids.size).toBe(8);
  });

  it('test #9: drillDown depth=3 over-walks safely — BFS exhausts at depth=2 since L1s have no children', () => {
    const l3 = makeL3Profile('alice profile depth3 test', 'alice');
    writeEntry(hippoRoot, l3);
    const l2 = makeL2Summary('alice topic for depth3', 'alice', l3.id);
    writeEntry(hippoRoot, l2);
    writeEntry(hippoRoot, makeL1Fact(l2.id, 'fact one for depth3 test'));
    writeEntry(hippoRoot, makeL1Fact(l2.id, 'fact two for depth3 test'));

    const r = drillDown(defaultCtx(hippoRoot), l3.id, { depth: 3 }) as DrillDownResult;
    expect('failure' in r).toBe(false);
    // 1 L2 + 2 L1s = 3 entries; depth=3 doesn't over-walk into nothing
    expect(r.children.length).toBe(3);
    expect(r.totalChildren).toBe(3);
  });

  it('test #10: drillDown depth=2 global budget truncates mid-walk', () => {
    const l3 = makeL3Profile('alice profile budget test', 'alice');
    writeEntry(hippoRoot, l3);
    const l2 = makeL2Summary('alice topic for budget test xxxxx', 'alice', l3.id);
    writeEntry(hippoRoot, l2);
    for (let i = 0; i < 5; i++) {
      writeEntry(hippoRoot, makeL1Fact(l2.id, `fact-${i} with substantial content here for budget test xxxxx yyyy zzzz`));
    }

    // Very tight budget — should truncate
    const r = drillDown(defaultCtx(hippoRoot), l3.id, { depth: 2, budget: 30 }) as DrillDownResult;
    expect('failure' in r).toBe(false);
    expect(r.truncated).toBe(true);
    expect(r.children.length).toBeLessThan(6);
  });

  it('test #11: drillDown depth tenant isolation — L1s in different tenant are excluded at level 2', () => {
    const l3 = makeL3Profile('alice profile tenant test', 'alice');
    writeEntry(hippoRoot, l3);
    const l2a = makeL2Summary('alice topic A in tenant-a', 'alice', l3.id);
    writeEntry(hippoRoot, l2a);

    // Anomaly: L1s in tenant-b with dag_parent_id pointing to tenant-a's L2-A
    const db = openHippoDb(hippoRoot);
    try {
      for (let i = 0; i < 3; i++) {
        const l1 = makeL1Fact(l2a.id, `cross-tenant-fact-${i} content here`);
        // Direct SQL to simulate cross-tenant data anomaly
        db.prepare(`
          INSERT INTO memories (id, content, layer, tags_json, dag_level, dag_parent_id, tenant_id, created, last_retrieved, retrieval_count, strength, half_life_days, emotional_valence, schema_fit, source, outcome_score, outcome_positive, outcome_negative, conflicts_with_json, pinned, confidence, parents_json, starred, kind, valid_from, summary_dirty)
          VALUES (?, ?, 'episodic', '["extracted"]', 1, ?, 'tenant-b', ?, ?, 0, 1.0, 7, 0, 1, 'extraction', 0, 0, 0, '[]', 0, 'inferred', '[]', 0, 'distilled', ?, 0)
        `).run(l1.id, l1.content, l2a.id, l1.created, l1.created, l1.created);
      }
    } finally {
      db.close();
    }

    const r = drillDown(defaultCtx(hippoRoot, 'default'), l3.id, { depth: 2 }) as DrillDownResult;
    expect('failure' in r).toBe(false);
    // Should return only L2-A (tenant-a), NOT the L1s in tenant-b
    expect(r.children.length).toBe(1);
    expect(r.children[0]!.id).toBe(l2a.id);
  });

  it('test #12: isDagSummary extended to L2 + L3', () => {
    const l3 = makeL3Profile('test profile content for isDagSummary', 'alice');
    const l2 = makeL2Summary('test summary content for isDagSummary', 'alice');
    const l1 = makeL1Fact('placeholder-parent-id-here-fake', 'l1 fact content for test');
    expect(isDagSummary(l3)).toBe(true);
    expect(isDagSummary(l2)).toBe(true);
    expect(isDagSummary(l1)).toBe(false);
  });

  it('test #14: buildEntityProfiles partitions clusters by tenantId (independent-review HIGH #1 lock)', async () => {
    // 3 alice L2s in tenant-A, 3 alice L2s in tenant-B with similar content
    const tenantAL2s = [
      'alice does python in tenant A repo one',
      'alice prefers type hints in tenant A repo one',
      'alice owns the API layer in tenant A repo one',
    ].map((c, _i) => {
      const m = makeL2Summary(c, 'alice');
      m.tenantId = 'tenant-a';
      return m;
    });
    const tenantBL2s = [
      'alice writes typescript in tenant B repo two',
      'alice prefers strict mode in tenant B repo two',
      'alice owns the frontend in tenant B repo two',
    ].map((c, _i) => {
      const m = makeL2Summary(c, 'alice');
      m.tenantId = 'tenant-b';
      return m;
    });
    [...tenantAL2s, ...tenantBL2s].forEach((e) => writeEntry(hippoRoot, e));

    const result = await buildEntityProfiles(
      hippoRoot,
      [...tenantAL2s, ...tenantBL2s],
      { apiKey: 'k', fetcher: makeOkFetcher('synthetic-multi-tenant-profile-content-xyz') },
    );
    // 2 L3s expected — one per tenant cluster (NOT one merged L3 in 'default')
    expect(result.profilesCreated).toBe(2);
    expect(result.l2sLinked).toBe(6);

    const db = openHippoDb(hippoRoot);
    try {
      const profiles = db.prepare(`SELECT id, tenant_id FROM memories WHERE dag_level = 3`).all() as any[];
      expect(profiles.length).toBe(2);
      const tenants = new Set(profiles.map((p) => p.tenant_id));
      expect(tenants.has('tenant-a')).toBe(true);
      expect(tenants.has('tenant-b')).toBe(true);
      expect(tenants.has('default')).toBe(false); // would indicate cross-tenant conflation
    } finally {
      db.close();
    }
  });

  it('test #13: E4 deboost applies to L3 in hybridSearch — breakdown.summaryDeboost=0.85, breakdown.dagLevel=3', async () => {
    const l3 = makeL3Profile('alice entity profile xyz searchable content', 'alice');
    writeEntry(hippoRoot, l3);
    const results = await hybridSearch('searchable xyz', [l3], { explain: true });
    expect(results.length).toBeGreaterThan(0);
    const br = results[0]!.breakdown;
    expect(br?.dagLevel).toBe(3);
    expect(br?.summaryDeboost).toBeCloseTo(0.85);
  });
});
