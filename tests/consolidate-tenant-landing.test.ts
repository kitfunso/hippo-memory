/**
 * T1 tests: docs/plans/2026-08-15-hardening-at1-followups.md
 *
 * Defect: consolidate.ts's merge pass clustered episodic entries purely by
 * textOverlap with no tenant boundary, and both the merge pass and the
 * trace pass called createMemory without a tenantId, so every
 * consolidation-produced row landed in 'default' regardless of its
 * source(s). Fix: partition the merge pass by tenantId before clustering
 * and thread tenantId through both createMemory calls (consolidate.ts) and
 * extract.ts's storeExtractedFacts (same one-line defect, folded in per the
 * plan's executor check).
 *
 * Real DB, per the project convention (rejection-acceptance.test.ts covers
 * the tombstone-interaction cases; this file covers plain landing).
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry, loadAllEntries, appendSessionEvent } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { consolidate } from '../src/consolidate.js';
import { storeExtractedFacts, type ExtractedFact } from '../src/extract.js';

function tmpHome(prefix: string = 'hippo-consolidate-tenant-landing-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('T1 (a): merge pass partitions by tenant before clustering', () => {
  it('two tenants with byte-identical overlapping episodic content produce two separate merged rows, each in its own source tenant, never mixed into one', async () => {
    const home = tmpHome();
    try {
      initStore(home);
      // Disable replay: it independently rehearses survivors and would
      // confound nothing here, but matches house convention for merge tests.
      writeFileSync(join(home, 'config.json'), JSON.stringify({ replay: { count: 0 } }), 'utf8');

      // Deliberately IDENTICAL text pair in both tenants. textOverlap has no
      // tenant awareness, so before the fix all 4 entries clustered together
      // (identical text => maximum overlap) into ONE row with
      // "[Consolidated pattern from 4 related memories]" landing in
      // 'default'. After the fix, tenant partition happens first: each
      // tenant's own 2 entries cluster on their own into a
      // "[Consolidated from 2 related memories]" row in that tenant.
      const shortText = 'rotate the staging tls certificates before expiry';
      const longText = 'rotate the staging tls certificates before expiry and notify the on-call channel';

      const aShort = createMemory(shortText, { layer: Layer.Episodic, tenantId: 'tenant-a' });
      const aLong = createMemory(longText, { layer: Layer.Episodic, tenantId: 'tenant-a' });
      const bShort = createMemory(shortText, { layer: Layer.Episodic, tenantId: 'tenant-b' });
      const bLong = createMemory(longText, { layer: Layer.Episodic, tenantId: 'tenant-b' });
      writeEntry(home, aShort);
      writeEntry(home, aLong);
      writeEntry(home, bShort);
      writeEntry(home, bLong);

      const result = await consolidate(home, { dryRun: false });

      // Two separate 2-entry merges, not one 4-entry merge.
      expect(result.semanticCreated).toBe(2);
      expect(result.merged).toBe(4);

      const allAfter = loadAllEntries(home);
      const semanticRows = allAfter.filter((e) => e.layer === Layer.Semantic);
      expect(semanticRows).toHaveLength(2);

      const byTenant = new Map(semanticRows.map((e) => [e.tenantId, e]));
      expect(byTenant.has('tenant-a')).toBe(true);
      expect(byTenant.has('tenant-b')).toBe(true);
      expect(byTenant.has('default')).toBe(false);

      // Both directions: neither row is the 4-way "pattern from 4" bulleted
      // form a cross-tenant cluster would have produced.
      for (const row of semanticRows) {
        expect(row.content).toContain('[Consolidated from 2 related memories]');
        expect(row.content).not.toContain('pattern from 4');
      }

      // Sources demoted (not deleted) under their OWN tenant — cross-check
      // no source crossed into the other tenant's row.
      const aSources = allAfter.filter((e) => e.tenantId === 'tenant-a' && e.layer === Layer.Episodic);
      const bSources = allAfter.filter((e) => e.tenantId === 'tenant-b' && e.layer === Layer.Episodic);
      expect(aSources).toHaveLength(2);
      expect(bSources).toHaveLength(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('T1 (c)+(d): trace pass lands in the resolved tenant and stays idempotent there', () => {
  it('an auto-promoted trace lands in HIPPO_TENANT (not default), and a second sleep does not regenerate it', async () => {
    const home = tmpHome();
    const prevTenant = process.env.HIPPO_TENANT;
    try {
      initStore(home);
      process.env.HIPPO_TENANT = 'tenant-x';

      const sid = 'test-session-tenant-x';
      appendSessionEvent(home, 'tenant-x', {
        session_id: sid, event_type: 'action', content: 'rotate the deploy key', source: 'agent',
      });
      appendSessionEvent(home, 'tenant-x', {
        session_id: sid,
        event_type: 'session_complete',
        content: 'success',
        source: 'agent',
        metadata: { summary: 'rotated the deploy key' },
      });

      const firstResult = await consolidate(home, { now: new Date() });
      expect(firstResult.promotedTraces).toBe(1);

      const allAfterFirst = loadAllEntries(home);
      const traces = allAfterFirst.filter((e) => e.layer === Layer.Trace);
      expect(traces).toHaveLength(1);
      // (c): the trace landed under the resolved tenant, not 'default' —
      // this is the fix; before it, createMemory omitted tenantId and every
      // trace stamped 'default' regardless of HIPPO_TENANT.
      expect(traces[0]!.tenantId).toBe('tenant-x');

      // (d): idempotency ghost regression pin. traceExistsForSession checks
      // under consolidationTenant ('tenant-x'). Before the fix the trace
      // itself lived in 'default', so that check never matched under a
      // non-default tenant and every sleep regenerated a duplicate trace.
      const secondResult = await consolidate(home, { now: new Date() });
      expect(secondResult.promotedTraces).toBe(0);

      const allAfterSecond = loadAllEntries(home);
      const tracesAfterSecond = allAfterSecond.filter((e) => e.layer === Layer.Trace);
      expect(tracesAfterSecond).toHaveLength(1);
    } finally {
      if (prevTenant === undefined) delete process.env.HIPPO_TENANT;
      else process.env.HIPPO_TENANT = prevTenant;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('T1 executor check: extract.ts storeExtractedFacts has the same defect, folded in', () => {
  it('extracted facts inherit the source entry tenant instead of stamping default', () => {
    const home = tmpHome();
    try {
      initStore(home);
      const source = createMemory('Alice prefers dark mode and vim keybindings', {
        layer: Layer.Episodic,
        tenantId: 'tenant-extract',
      });
      writeEntry(home, source);

      const facts: ExtractedFact[] = [
        { content: 'Alice prefers dark mode', tags: ['speaker:alice'], valence: 'neutral' },
      ];
      const stored = storeExtractedFacts(home, source, facts);

      expect(stored).toHaveLength(1);
      expect(stored[0]!.tenantId).toBe('tenant-extract');

      const persisted = loadAllEntries(home).find((e) => e.id === stored[0]!.id);
      expect(persisted).toBeDefined();
      expect(persisted!.tenantId).toBe('tenant-extract');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
