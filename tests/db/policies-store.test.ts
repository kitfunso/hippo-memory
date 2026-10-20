/**
 * E2 policy first-class object (bi-temporal-first) - store-layer tests.
 * Docs: docs/plans/2026-05-30-e2-policy-object.md
 *
 * Covers what only policies have; the shared lifecycle rules run per kind in typed-object-store.test.ts.
 * 1. savePolicy creates memory + policies row (+ policy_create audit); v1; valid_from defaults to now; valid_to null
 * 2. savePolicy with explicit from/to; memory content has name + text + range
 * 3. status filters
 * 4. DATE validation: inverted valid_to rejected (writes nothing); malformed rejected; overflow rolls; default now
 * 5. normalizePolicyDate canonicalization (date-only -> midnight Z; invalid throws)
 * 6. AS-OF query: half-open boundary; open-ended; name filter; excludes superseded/not-yet/expired
 * 7. CRIT regression: a date-only valid_from is returned by a date-only as-of for the same day (normalization)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import {
  savePolicy,
  closePolicy,
  loadPolicies,
  policiesAsOf,
  normalizePolicyDate,
} from '../../src/domain/objects/policies.js';
import { makeRoot } from '../_helpers/make-root.js';
import { objectsAt } from '../_helpers/objects-at.js';
import { loadConfig } from '../../src/base/config/config.js';
import { oneRequestPerTest, removeAfterRequest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

/** Query a single row from the hippo SQLite handle. */
function queryOne<T>(db: DatabaseSyncLike, sql: string, ...params: unknown[]): T | undefined {
  // SAFETY: sql is a literal SELECT against known hippo schema columns; the
  // row shape is declared by the generic type argument at each call site and
  // checked immediately by the assertions that follow.
  return db.prepare(sql).get(...params) as T | undefined;
}

/** Query all rows from the hippo SQLite handle. */
function queryAll<T>(db: DatabaseSyncLike, sql: string, ...params: unknown[]): T[] {
  // SAFETY: sql is a literal SELECT against known hippo schema columns; the
  // row shape is declared by the generic type argument at each call site and
  // checked immediately by the assertions that follow.
  return db.prepare(sql).all(...params) as T[];
}

function countRows(home: string, table: string): number {
  const db = openHippoDb(home);
  try {
    // SAFETY: table is always one of this test file's own literal SQL
    // identifiers, never external input.
    return queryOne<{ c: number }>(db, `SELECT COUNT(*) as c FROM ${table}`)!.c;
  } finally {
    closeHippoDb(db);
  }
}

describe('policies store (bi-temporal first-class object)', () => {
  let home: string;
  beforeEach(() => {
    home = makeRoot('policies');
  });
  afterEach(() => removeAfterRequest(home));

  it('savePolicy creates memory + policies row + policy_create audit; v1; valid_from defaults to creation instant', async () => {
    const before = new Date().toISOString();
    const p = await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      policyName: 'Retention',
      policyText: 'Delete logs after 90d',
    });
    // The first row of a fresh AUTOINCREMENT table.
    expect(p.id).toBe(1);
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
      const memRow = queryOne<{ content: string; source: string; tags_json: string }>(
        db,
        `SELECT content, source, tags_json FROM memories WHERE id = ?`,
        p.memoryId!,
      )!;
      expect(memRow.content).toContain('Retention');
      expect(memRow.content).toContain('Delete logs after 90d');
      expect(memRow.content).toContain('Effective:');
      expect(memRow.source).toBe('policy');
      // SAFETY: tags_json is this test's own row, written by savePolicy as a
      // JSON.stringify'd string[] (memory tags column).
      expect(JSON.parse(memRow.tags_json) as string[]).toContain('policy');
      const rows = queryAll<{ metadata_json: string }>(
        db,
        `SELECT metadata_json FROM audit_log WHERE op='policy_create' AND target_id=?`,
        String(p.id),
      );
      expect(rows.length).toBe(1);
      // SAFETY: metadata_json is this test's own audit row, written by
      // savePolicy's policy_create audit call with this exact shape.
      expect((JSON.parse(rows[0].metadata_json) as { open_ended: boolean }).open_ended).toBe(true);
    } finally {
      closeHippoDb(db);
    }
  });

  it('savePolicy with explicit from/to; range in content; canonicalized', async () => {
    const p = await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      policyName: 'Window',
      policyText: 'rule',
      validFrom: '2026-01-01',
      validTo: '2026-06-01',
    });
    expect(p.validFrom).toBe('2026-01-01T00:00:00.000Z');
    expect(p.validTo).toBe('2026-06-01T00:00:00.000Z');
  });

  it('status filters; status active', async () => {
    const a = await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      policyName: 'a',
      policyText: 'x',
    });
    const b = await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      policyName: 'b',
      policyText: 'x',
    });
    const c = await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      policyName: 'c',
      policyText: 'x',
    });
    await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      policyName: 'b',
      policyText: 'x2',
      supersedesPolicyId: b.id,
    });
    await closePolicy(objectsAt(home), 'default', c.id);
    const active = await loadPolicies(objectsAt(home), 'default', { status: 'active' });
    expect(active.some((x) => x.id === a.id)).toBe(true);
    expect(active.some((x) => x.id === b.id)).toBe(false);
    expect(active.some((x) => x.id === c.id)).toBe(false);
    expect((await loadPolicies(objectsAt(home), 'default', { status: 'closed' })).map((x) => x.id)).toEqual([c.id]);
    expect((await loadPolicies(objectsAt(home), 'default')).length).toBe(4);
  });

  it('date validation: inverted rejected (writes nothing); malformed rejected; overflow rolls', async () => {
    const p0 = countRows(home, 'policies');
    await expect(
      savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
        policyName: 'Inv',
        policyText: 'x',
        validFrom: '2026-06-01',
        validTo: '2026-01-01',
      }),
    ).rejects.toThrow(/must be strictly after/);
    await expect(
      savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
        policyName: 'Inv',
        policyText: 'x',
        validFrom: '2026-01-01',
        validTo: '2026-01-01',
      }),
    ).rejects.toThrow(/must be strictly after/);
    await expect(
      savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
        policyName: 'Bad',
        policyText: 'x',
        validFrom: 'not-a-date',
      }),
    ).rejects.toThrow(/invalid valid_from/);
    expect(countRows(home, 'policies')).toBe(p0); // nothing persisted on any rejection
    // overflow rolls forward (JS Date), accepted + canonical
    const roll = await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      policyName: 'Roll',
      policyText: 'x',
      validFrom: '2026-02-30',
    });
    expect(roll.validFrom).toBe('2026-03-02T00:00:00.000Z');
  });

  it('normalizePolicyDate canonicalizes date-only to midnight Z; throws on garbage', () => {
    expect(normalizePolicyDate('2026-01-01')).toBe('2026-01-01T00:00:00.000Z');
    expect(normalizePolicyDate('2026-01-01T14:23:00.000Z')).toBe('2026-01-01T14:23:00.000Z');
    expect(() => normalizePolicyDate('garbage')).toThrow(/invalid date/);
  });

  it('as-of query: half-open boundary; open-ended; name filter; excludes superseded/not-yet/expired', async () => {
    // Windowed policy [2026-01-01, 2026-06-01)
    await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      policyName: 'W',
      policyText: 'win',
      validFrom: '2026-01-01',
      validTo: '2026-06-01',
    });
    // Open-ended from 2026-03-01
    await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      policyName: 'O',
      policyText: 'open',
      validFrom: '2026-03-01',
    });

    // mid-window: both? W is in force (Jan-Jun), O in force (Mar onward) at 2026-04-01
    const apr = (await policiesAsOf(objectsAt(home), 'default', '2026-04-01')).map((x) => x.policyName).sort();
    expect(apr).toEqual(['O', 'W']);
    // before any: 2025-12-01 -> none
    expect((await policiesAsOf(objectsAt(home), 'default', '2025-12-01')).length).toBe(0);
    // == valid_from boundary IS in force
    expect((await policiesAsOf(objectsAt(home), 'default', '2026-01-01', { name: 'W' })).length).toBe(1);
    // == valid_to boundary is NOT in force (half-open)
    expect((await policiesAsOf(objectsAt(home), 'default', '2026-06-01', { name: 'W' })).length).toBe(0);
    // just before valid_to IS in force
    expect((await policiesAsOf(objectsAt(home), 'default', '2026-05-31', { name: 'W' })).length).toBe(1);
    // name filter
    expect(
      (await policiesAsOf(objectsAt(home), 'default', '2026-04-01', { name: 'O' })).map((x) => x.policyName),
    ).toEqual(['O']);

    // superseded rows excluded: supersede W, the superseded row must not appear
    const wRows = (await loadPolicies(objectsAt(home), 'default', { status: 'active' })).filter(
      (x) => x.policyName === 'W',
    );
    await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      policyName: 'W',
      policyText: 'win2',
      validFrom: '2026-01-01',
      validTo: '2026-06-01',
      supersedesPolicyId: wRows[0].id,
    });
    const aprAfter = await policiesAsOf(objectsAt(home), 'default', '2026-04-01', { name: 'W' });
    expect(aprAfter.length).toBe(1); // only the active successor, not the superseded original
    expect(aprAfter[0].version).toBe(2);
  });

  it('as-of returns a historically-valid superseded version', async () => {
    // v1 valid Jan-Dec, superseded in May by a successor effective from May.
    const v1 = await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      policyName: 'Hist',
      policyText: 'jan rule',
      validFrom: '2026-01-01',
      validTo: '2026-12-01',
    });
    await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      policyName: 'Hist',
      policyText: 'may rule',
      validFrom: '2026-05-01',
      validTo: '2026-12-01',
      supersedesPolicyId: v1.id,
    });
    // asof March: v1 was in force then; its successor (May) was not yet effective -> v1
    const march = await policiesAsOf(objectsAt(home), 'default', '2026-03-01', { name: 'Hist' });
    expect(march.length).toBe(1);
    expect(march[0].version).toBe(1);
    expect(march[0].status).toBe('superseded');
    // asof May 15: successor is now effective -> v2 only (v1 shadowed)
    const may = await policiesAsOf(objectsAt(home), 'default', '2026-05-15', { name: 'Hist' });
    expect(may.length).toBe(1);
    expect(may[0].version).toBe(2);
    expect(may[0].status).toBe('active');
  });

  it('as-of excludes closed policies (transaction-time-travel deferred)', async () => {
    const p = await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      policyName: 'Cl',
      policyText: 'x',
      validFrom: '2026-01-01',
    });
    await closePolicy(objectsAt(home), 'default', p.id);
    expect((await policiesAsOf(objectsAt(home), 'default', '2026-06-01', { name: 'Cl' })).length).toBe(0);
  });

  it('read-side date-only as-of resolves to end-of-day so a same-day policy is in force', async () => {
    const before = new Date().toISOString();
    const p = await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      policyName: 'Today',
      policyText: 'x',
    });
    // valid_from is the honest creation instant, NOT backdated to midnight.
    expect(p.validFrom >= before).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    // a date-only as-of for today resolves to end-of-day, so a policy created
    // earlier today IS in force.
    expect((await policiesAsOf(objectsAt(home), 'default', today, { name: 'Today' })).length).toBe(1);
    // a precise as-of clearly BEFORE creation correctly excludes it (honest).
    expect((await policiesAsOf(objectsAt(home), 'default', '2020-01-01T00:00:00.000Z', { name: 'Today' })).length).toBe(
      0,
    );
  });

  it('CRIT regression: a date-only valid_from is in force for a date-only as-of on the same day (normalization)', async () => {
    // Pre-fix, a datetime valid_from vs a date-only asOf produced a lexical-prefix
    // miss. Post-fix both normalize to midnight Z, so the == valid_from boundary holds.
    await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      policyName: 'Day',
      policyText: 'x',
      validFrom: '2026-01-01',
    });
    const hit = await policiesAsOf(objectsAt(home), 'default', '2026-01-01', { name: 'Day' });
    expect(hit.length).toBe(1);
    // And a default-valid_from (now) policy is in force for a clearly-future as-of.
    await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      policyName: 'Now',
      policyText: 'x',
    });
    expect((await policiesAsOf(objectsAt(home), 'default', '2099-01-01', { name: 'Now' })).length).toBe(1);
  });
});
