/**
 * E2 policy first-class object (bi-temporal-first) - store-layer tests.
 * Docs: docs/plans/2026-05-30-e2-policy-object.md
 *
 * Covers:
 * 1. savePolicy creates memory + policies row (+ policy_create audit); v1; valid_from defaults to now; valid_to null
 * 2. savePolicy with explicit from/to; memory content has name + text + range
 * 3. SAVEPOINT atomicity
 * 4. supersede: predecessor->superseded, v2, change_summary, policy_supersede audit
 * 5. version chain v1->v2->v3
 * 6. supersede CAS (re-supersede fails not-active; missing id not-found)
 * 7. self-supersede preflight guard (empty store)
 * 8. close (active->closed); close guard (not-found; cannot-close-superseded)
 * 9. cross-tenant INSERT trigger; supersede tenant-match trigger
 * 10. ON DELETE SET NULL + old version loadable
 * 11. status filters; loadActivePolicies; invalid status
 * 12. DATE validation: inverted valid_to rejected (writes nothing); malformed rejected; overflow rolls; default now
 * 13. normalizePolicyDate canonicalization (date-only -> midnight Z; invalid throws)
 * 14. AS-OF query: half-open boundary; open-ended; name filter; excludes superseded/not-yet/expired
 * 15. CRIT regression: a date-only valid_from is returned by a date-only as-of for the same day (normalization)
 * 16. schema v33 table + 3 triggers + 3 indexes
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, deleteEntry, writeEntry } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import {
  savePolicy,
  closePolicy,
  loadPolicyById,
  loadPolicies,
  loadActivePolicies,
  loadPoliciesAsOf,
  normalizePolicyDate,
  VALID_POLICY_STATES,
} from '../src/policies.js';

function makeRoot(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), `hippo-${prefix}-`));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}
function safeRmSync(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}
function countRows(home: string, table: string): number {
  const db = openHippoDb(home);
  try { return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c; }
  finally { closeHippoDb(db); }
}

describe('policies store (E2 bi-temporal first-class object)', () => {
  let home: string;
  beforeEach(() => { home = makeRoot('policies'); });
  afterEach(() => safeRmSync(home));

  it('savePolicy creates memory + policies row + policy_create audit; v1; valid_from defaults to creation instant', () => {
    const before = new Date().toISOString();
    const p = savePolicy(home, 'default', { policyName: 'Retention', policyText: 'Delete logs after 90d' });
    expect(p.id).toBeGreaterThan(0);
    expect(p.memoryId).not.toBeNull();
    expect(p.policyName).toBe('Retention');
    expect(p.policyText).toBe('Delete logs after 90d');
    expect(p.version).toBe(1);
    expect(p.status).toBe('active');
    expect(p.validTo).toBeNull();
    expect(p.changeSummary).toBeNull();
    // valid_from defaults to the precise creation instant (honest effective
    // time); the same-day date-only as-of is handled on the read side.
    expect(p.validFrom >= before).toBe(true);
    expect(p.validFrom).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const db = openHippoDb(home);
    try {
      const memRow = db.prepare(`SELECT content, source, tags_json FROM memories WHERE id = ?`)
        .get(p.memoryId!) as { content: string; source: string; tags_json: string };
      expect(memRow.content).toContain('Retention');
      expect(memRow.content).toContain('Delete logs after 90d');
      expect(memRow.content).toContain('Effective:');
      expect(memRow.source).toBe('policy');
      expect((JSON.parse(memRow.tags_json) as string[])).toContain('policy');
      const rows = db.prepare(`SELECT metadata_json FROM audit_log WHERE op='policy_create' AND target_id=?`)
        .all(String(p.id)) as Array<{ metadata_json: string }>;
      expect(rows.length).toBe(1);
      expect((JSON.parse(rows[0].metadata_json) as { open_ended: boolean }).open_ended).toBe(true);
    } finally { closeHippoDb(db); }
  });

  it('savePolicy with explicit from/to; range in content; canonicalized', () => {
    const p = savePolicy(home, 'default', {
      policyName: 'Window', policyText: 'rule', validFrom: '2026-01-01', validTo: '2026-06-01',
    });
    expect(p.validFrom).toBe('2026-01-01T00:00:00.000Z');
    expect(p.validTo).toBe('2026-06-01T00:00:00.000Z');
  });

  it('SAVEPOINT atomicity: writeEntry throw rolls back both', () => {
    const m0 = countRows(home, 'memories'); const p0 = countRows(home, 'policies');
    const mem = createMemory('throwing policy', {
      tags: ['policy'], layer: Layer.Semantic, confidence: 'verified', source: 'policy', tenantId: 'default',
    });
    expect(() => writeEntry(home, mem, { afterWrite: () => { throw new Error('forced'); } })).toThrow('forced');
    expect(countRows(home, 'memories')).toBe(m0);
    expect(countRows(home, 'policies')).toBe(p0);
  });

  it('supersede: predecessor->superseded, v2, change_summary + policy_supersede audit', () => {
    const v1 = savePolicy(home, 'default', { policyName: 'P', policyText: 'old rule' });
    const v2 = savePolicy(home, 'default', {
      policyName: 'P', policyText: 'new rule', changeSummary: 'tightened', supersedesPolicyId: v1.id,
    });
    expect(v2.version).toBe(2);
    expect(v2.changeSummary).toBe('tightened');
    const reV1 = loadPolicyById(home, 'default', v1.id)!;
    expect(reV1.status).toBe('superseded');
    expect(reV1.supersededBy).toBe(v2.id);
    const db = openHippoDb(home);
    try {
      const rows = db.prepare(`SELECT 1 FROM audit_log WHERE op='policy_supersede' AND target_id=?`).all(String(v1.id));
      expect(rows.length).toBe(1);
    } finally { closeHippoDb(db); }
  });

  it('version chain v1->v2->v3 server-derived', () => {
    const v1 = savePolicy(home, 'default', { policyName: 'C', policyText: 'a' });
    const v2 = savePolicy(home, 'default', { policyName: 'C', policyText: 'b', supersedesPolicyId: v1.id });
    const v3 = savePolicy(home, 'default', { policyName: 'C', policyText: 'c', supersedesPolicyId: v2.id });
    expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);
    expect(loadActivePolicies(home, 'default').map((x) => x.id)).toEqual([v3.id]);
  });

  it('supersede CAS: re-superseding a superseded row throws not-active; missing id throws not-found', () => {
    const v1 = savePolicy(home, 'default', { policyName: 'O', policyText: 'a' });
    savePolicy(home, 'default', { policyName: 'O', policyText: 'b', supersedesPolicyId: v1.id });
    expect(() => savePolicy(home, 'default', { policyName: 'O', policyText: 'c', supersedesPolicyId: v1.id })).toThrow(/not active/);
    expect(() => savePolicy(home, 'default', { policyName: 'X', policyText: 'c', supersedesPolicyId: 99999 })).toThrow(/not found/);
  });

  it('self-supersede preflight guard: supersede on empty store throws not-found, creates nothing', () => {
    const p0 = countRows(home, 'policies');
    expect(() => savePolicy(home, 'default', { policyName: 'S', policyText: 'a', supersedesPolicyId: 1 })).toThrow(/not found/);
    expect(countRows(home, 'policies')).toBe(p0);
  });

  it('close (active->closed); close guard (not-found; cannot-close-superseded; cannot re-close)', () => {
    expect(() => closePolicy(home, 'default', 77777)).toThrow(/not found/);
    const v1 = savePolicy(home, 'default', { policyName: 'Sup', policyText: 'a' });
    savePolicy(home, 'default', { policyName: 'Sup', policyText: 'b', supersedesPolicyId: v1.id });
    expect(() => closePolicy(home, 'default', v1.id)).toThrow(/not active/);
    const c = savePolicy(home, 'default', { policyName: 'Cl', policyText: 'a' });
    closePolicy(home, 'default', c.id);
    expect(() => closePolicy(home, 'default', c.id)).toThrow(/not active/);
  });

  it('cross-tenant INSERT trigger + supersede tenant-match trigger raise ABORT', () => {
    const mem = createMemory('tenant-a', {
      tags: ['policy'], layer: Layer.Semantic, confidence: 'verified', source: 'policy', tenantId: 'tenant-a',
    });
    writeEntry(home, mem);
    const db = openHippoDb(home);
    try {
      expect(() => {
        db.prepare(`INSERT INTO policies(memory_id, tenant_id, policy_name, policy_text, valid_from, version, status, created_at)
          VALUES (?, 'tenant-b', 'x', 'y', ?, 1, 'active', ?)`).run(mem.id, new Date().toISOString(), new Date().toISOString());
      }).toThrow(/tenant_id must match memories\.tenant_id/);
    } finally { closeHippoDb(db); }

    const a = savePolicy(home, 'tenant-a', { policyName: 'A', policyText: 'a' });
    const b = savePolicy(home, 'tenant-b', { policyName: 'B', policyText: 'b' });
    const db2 = openHippoDb(home);
    try {
      expect(() => db2.prepare(`UPDATE policies SET superseded_by=? WHERE id=?`).run(b.id, a.id))
        .toThrow(/superseded_by must reference a policy in the same tenant/);
    } finally { closeHippoDb(db2); }
  });

  it('ON DELETE SET NULL: forgetting the memory orphans the policy; old versions stay loadable', () => {
    const v1 = savePolicy(home, 'default', { policyName: 'D', policyText: 'a' });
    const v2 = savePolicy(home, 'default', { policyName: 'D', policyText: 'b', supersedesPolicyId: v1.id });
    deleteEntry(home, v1.memoryId!, 'default');
    deleteEntry(home, v2.memoryId!, 'default');
    const reV1 = loadPolicyById(home, 'default', v1.id)!;
    expect(reV1.memoryId).toBeNull();
    expect(reV1.status).toBe('superseded');
    expect(loadPolicyById(home, 'default', v2.id)!.status).toBe('active');
  });

  it('status filters; loadActivePolicies; invalid status', () => {
    const a = savePolicy(home, 'default', { policyName: 'a', policyText: 'x' });
    const b = savePolicy(home, 'default', { policyName: 'b', policyText: 'x' });
    const c = savePolicy(home, 'default', { policyName: 'c', policyText: 'x' });
    savePolicy(home, 'default', { policyName: 'b', policyText: 'x2', supersedesPolicyId: b.id });
    closePolicy(home, 'default', c.id);
    const active = loadActivePolicies(home, 'default');
    expect(active.some((x) => x.id === a.id)).toBe(true);
    expect(active.some((x) => x.id === b.id)).toBe(false);
    expect(active.some((x) => x.id === c.id)).toBe(false);
    expect(loadPolicies(home, 'default', { status: 'closed' }).map((x) => x.id)).toEqual([c.id]);
    expect(loadPolicies(home, 'default').length).toBe(4);
    // @ts-expect-error runtime validation
    expect(() => loadPolicies(home, 'default', { status: 'retired' })).toThrow(/status must be one of/);
    expect(VALID_POLICY_STATES.has('active')).toBe(true);
  });

  it('date validation: inverted rejected (writes nothing); malformed rejected; overflow rolls', () => {
    const p0 = countRows(home, 'policies');
    expect(() => savePolicy(home, 'default', {
      policyName: 'Inv', policyText: 'x', validFrom: '2026-06-01', validTo: '2026-01-01',
    })).toThrow(/must be strictly after/);
    expect(() => savePolicy(home, 'default', {
      policyName: 'Inv', policyText: 'x', validFrom: '2026-01-01', validTo: '2026-01-01',
    })).toThrow(/must be strictly after/);
    expect(() => savePolicy(home, 'default', {
      policyName: 'Bad', policyText: 'x', validFrom: 'not-a-date',
    })).toThrow(/invalid valid_from/);
    expect(countRows(home, 'policies')).toBe(p0); // nothing persisted on any rejection
    // overflow rolls forward (JS Date), accepted + canonical
    const roll = savePolicy(home, 'default', { policyName: 'Roll', policyText: 'x', validFrom: '2026-02-30' });
    expect(roll.validFrom).toBe('2026-03-02T00:00:00.000Z');
  });

  it('normalizePolicyDate canonicalizes date-only to midnight Z; throws on garbage', () => {
    expect(normalizePolicyDate('2026-01-01')).toBe('2026-01-01T00:00:00.000Z');
    expect(normalizePolicyDate('2026-01-01T14:23:00.000Z')).toBe('2026-01-01T14:23:00.000Z');
    expect(() => normalizePolicyDate('garbage')).toThrow(/invalid date/);
  });

  it('as-of query: half-open boundary; open-ended; name filter; excludes superseded/not-yet/expired', () => {
    // Windowed policy [2026-01-01, 2026-06-01)
    savePolicy(home, 'default', { policyName: 'W', policyText: 'win', validFrom: '2026-01-01', validTo: '2026-06-01' });
    // Open-ended from 2026-03-01
    savePolicy(home, 'default', { policyName: 'O', policyText: 'open', validFrom: '2026-03-01' });

    // mid-window: both? W is in force (Jan-Jun), O in force (Mar onward) at 2026-04-01
    const apr = loadPoliciesAsOf(home, 'default', '2026-04-01').map((x) => x.policyName).sort();
    expect(apr).toEqual(['O', 'W']);
    // before any: 2025-12-01 -> none
    expect(loadPoliciesAsOf(home, 'default', '2025-12-01').length).toBe(0);
    // == valid_from boundary IS in force
    expect(loadPoliciesAsOf(home, 'default', '2026-01-01', { name: 'W' }).length).toBe(1);
    // == valid_to boundary is NOT in force (half-open)
    expect(loadPoliciesAsOf(home, 'default', '2026-06-01', { name: 'W' }).length).toBe(0);
    // just before valid_to IS in force
    expect(loadPoliciesAsOf(home, 'default', '2026-05-31', { name: 'W' }).length).toBe(1);
    // name filter
    expect(loadPoliciesAsOf(home, 'default', '2026-04-01', { name: 'O' }).map((x) => x.policyName)).toEqual(['O']);

    // superseded rows excluded: supersede W, the superseded row must not appear
    const wRows = loadPolicies(home, 'default', { status: 'active' }).filter((x) => x.policyName === 'W');
    savePolicy(home, 'default', { policyName: 'W', policyText: 'win2', validFrom: '2026-01-01', validTo: '2026-06-01', supersedesPolicyId: wRows[0].id });
    const aprAfter = loadPoliciesAsOf(home, 'default', '2026-04-01', { name: 'W' });
    expect(aprAfter.length).toBe(1); // only the active successor, not the superseded original
    expect(aprAfter[0].version).toBe(2);
  });

  it('as-of returns a historically-valid superseded version (codex P2 #2)', () => {
    // v1 valid Jan-Dec, superseded in May by a successor effective from May.
    const v1 = savePolicy(home, 'default', { policyName: 'Hist', policyText: 'jan rule', validFrom: '2026-01-01', validTo: '2026-12-01' });
    savePolicy(home, 'default', { policyName: 'Hist', policyText: 'may rule', validFrom: '2026-05-01', validTo: '2026-12-01', supersedesPolicyId: v1.id });
    // asof March: v1 was in force then; its successor (May) was not yet effective -> v1
    const march = loadPoliciesAsOf(home, 'default', '2026-03-01', { name: 'Hist' });
    expect(march.length).toBe(1);
    expect(march[0].version).toBe(1);
    expect(march[0].status).toBe('superseded');
    // asof May 15: successor is now effective -> v2 only (v1 shadowed)
    const may = loadPoliciesAsOf(home, 'default', '2026-05-15', { name: 'Hist' });
    expect(may.length).toBe(1);
    expect(may[0].version).toBe(2);
    expect(may[0].status).toBe('active');
  });

  it('as-of excludes closed policies (transaction-time-travel deferred)', () => {
    const p = savePolicy(home, 'default', { policyName: 'Cl', policyText: 'x', validFrom: '2026-01-01' });
    closePolicy(home, 'default', p.id);
    expect(loadPoliciesAsOf(home, 'default', '2026-06-01', { name: 'Cl' }).length).toBe(0);
  });

  it('read-side date-only as-of resolves to end-of-day so a same-day policy is in force (codex P2 #1, round-2 fix)', () => {
    const before = new Date().toISOString();
    const p = savePolicy(home, 'default', { policyName: 'Today', policyText: 'x' });
    // valid_from is the honest creation instant, NOT backdated to midnight.
    expect(p.validFrom >= before).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    // a date-only as-of for today resolves to end-of-day, so a policy created
    // earlier today IS in force.
    expect(loadPoliciesAsOf(home, 'default', today, { name: 'Today' }).length).toBe(1);
    // a precise as-of clearly BEFORE creation correctly excludes it (honest).
    expect(loadPoliciesAsOf(home, 'default', '2020-01-01T00:00:00.000Z', { name: 'Today' }).length).toBe(0);
  });

  it('CRIT regression: a date-only valid_from is in force for a date-only as-of on the same day (normalization)', () => {
    // Pre-fix, a datetime valid_from vs a date-only asOf produced a lexical-prefix
    // miss. Post-fix both normalize to midnight Z, so the == valid_from boundary holds.
    savePolicy(home, 'default', { policyName: 'Day', policyText: 'x', validFrom: '2026-01-01' });
    const hit = loadPoliciesAsOf(home, 'default', '2026-01-01', { name: 'Day' });
    expect(hit.length).toBe(1);
    // And a default-valid_from (now) policy is in force for a clearly-future as-of.
    savePolicy(home, 'default', { policyName: 'Now', policyText: 'x' });
    expect(loadPoliciesAsOf(home, 'default', '2099-01-01', { name: 'Now' }).length).toBe(1);
  });

  it('schema v33 produces policies table + 3 triggers + 3 indexes', () => {
    const db = openHippoDb(home);
    try {
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='policies'`).get()).toBeDefined();
      const triggers = (db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_policies_%'`)
        .all() as Array<{ name: string }>).map((t) => t.name);
      expect(triggers).toContain('trg_policies_tenant_match_insert');
      expect(triggers).toContain('trg_policies_tenant_match_update');
      expect(triggers).toContain('trg_policies_supersede_tenant_match_update');
      const indexes = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_policies_%'`)
        .all() as Array<{ name: string }>).map((i) => i.name);
      expect(indexes).toContain('idx_policies_tenant_status');
      expect(indexes).toContain('idx_policies_memory');
      expect(indexes).toContain('idx_policies_asof');
    } finally { closeHippoDb(db); }
  });
});
