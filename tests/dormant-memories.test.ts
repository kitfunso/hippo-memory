/**
 * Dormant memories: what sleep does with a faded memory instead of deleting it.
 *
 * On by default (`"dormant": { "enabled": false }` opts out). The sleep decay
 * pass moves a memory that faded below the threshold out of active memory
 * into the dormant store. Dormant memories never reach recall or context,
 * sit out every later sleep, and can be listed, searched, restored or
 * permanently forgotten. Guardrails: a faded secret is deleted, never kept
 * dormant, and a dormant memory older than `retentionDays` (default 180, 0 =
 * forever) is deleted for good. Real SQLite throughout.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { entryMirrorFiles } from './_helpers/entry-mirror-files.js';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { MEMORY_BACKED_TABLES } from '../src/store/delete-and-batch.js';
import { loadStats } from '../src/store/index-and-stats.js';
import { saveDecision } from '../src/objects/decisions.js';
import { saveIncident } from '../src/objects/incidents.js';
import { saveProcess } from '../src/objects/processes.js';
import { savePolicy } from '../src/objects/policies.js';
import { saveSkill } from '../src/objects/skills.js';
import { saveProjectBrief } from '../src/objects/project-briefs.js';
import { saveCustomerNote } from '../src/objects/customer-notes.js';
import { savePrediction } from '../src/store/predictions.js';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import { queryAuditEvents, type AuditEvent, type AuditOp } from '../src/store/audit.js';
import { consolidate } from '../src/consolidate/sleep.js';
import { insertDormantRow } from '../src/store/dormant.js';
import { loadConfig } from '../src/core/config.js';
import { createMemory, Layer, calculateStrength, DEFAULT_HALF_LIFE_DAYS, type MemoryEntry } from '../src/core/memory.js';
import { RejectedValueError, rejectionDigest, insertRejectedValue } from '../src/store/rejection.js';
import * as api from '../src/api/index.js';
import { WRITE_BUDGET } from '../src/util/write-budget.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DORMANT_ON = JSON.stringify({ replay: { count: 0 }, dormant: { enabled: true } });
const DORMANT_OFF = JSON.stringify({ replay: { count: 0 }, dormant: { enabled: false } });

function tmpHome(prefix: string, config: string) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  initStore(home);
  writeFileSync(join(home, 'config.json'), config, 'utf8');
  return { home, restore: () => rmSync(home, { recursive: true, force: true }) };
}

/** `entry` aged `days`, on the pre-1.46 7-day base so it fades within the test's horizon. */
function aged(entry: MemoryEntry, days: number): MemoryEntry {
  const then = new Date(Date.now() - days * DAY_MS).toISOString();
  return { ...entry, half_life_days: (entry.half_life_days * 7) / DEFAULT_HALF_LIFE_DAYS, created: then, last_retrieved: then };
}

function ctxFor(home: string, tenantId = 'default'): api.Context {
  return { hippoRoot: home, tenantId, actor: { subject: 'test', role: 'admin' } };
}

function auditRows(home: string, op: AuditOp): AuditEvent[] {
  const db = openHippoDb(home);
  try {
    return queryAuditEvents(db, { tenantId: 'default', op });
  } finally {
    closeHippoDb(db);
  }
}

function countDormantRows(home: string): number {
  const db = openHippoDb(home);
  try {
    // SAFETY: row's shape matches the single aliased COUNT column in the SELECT.
    const row = db.prepare(`SELECT COUNT(*) AS n FROM dormant_memories`).get() as { n: number };
    return row.n;
  } finally {
    closeHippoDb(db);
  }
}

describe('dormant memories are on by default, with an opt-out', () => {
  function captureWarnings(fn: () => void): string[] {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      fn();
      return stderr.mock.calls.map(([chunk]) => String(chunk));
    } finally {
      stderr.mockRestore();
    }
  }

  it('with no dormant setting a faded memory goes dormant, and retention defaults to 180 days', async () => {
    const { home, restore } = tmpHome('hippo-dormant-default-', JSON.stringify({ replay: { count: 0 } }));
    try {
      const faded = aged(createMemory('the old staging hostname was build-07 before the move', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), 90);
      writeEntry(home, faded);

      const result = await consolidate(home, { now: new Date() });

      expect(result.removed).toBe(0);
      expect(result.dormant).toBe(1);
      expect(api.listDormant(ctxFor(home)).map((m) => m.id)).toEqual([faded.id]);
      expect(loadConfig(home).dormant).toEqual({ enabled: true, retentionDays: 180 });
    } finally {
      restore();
    }
  });

  it('opting out deletes a faded memory as before', async () => {
    const { home, restore } = tmpHome('hippo-dormant-off-', DORMANT_OFF);
    try {
      const faded = aged(createMemory('the old staging hostname was build-07 before the move', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), 90);
      writeEntry(home, faded);

      const result = await consolidate(home, { now: new Date() });

      expect(result.removed).toBe(1);
      expect(result.dormant).toBe(0);
      expect(loadAllEntries(home).map((e) => e.id)).not.toContain(faded.id);
      expect(countDormantRows(home)).toBe(0);
    } finally {
      restore();
    }
  });

  it('a malformed setting warns and falls back to the default, which keeps faded memories', () => {
    for (const bad of [{ dormant: true }, { dormant: { enabled: 'false' } }]) {
      const { home, restore } = tmpHome('hippo-dormant-badcfg-', JSON.stringify(bad));
      try {
        let enabled: boolean | undefined;
        const warnings = captureWarnings(() => { enabled = loadConfig(home).dormant.enabled; });
        expect(enabled).toBe(true);
        expect(warnings.some((w) => w.includes('"dormant'))).toBe(true);
      } finally {
        restore();
      }
    }
    const { home, restore } = tmpHome('hippo-dormant-badretention-', JSON.stringify({ dormant: { retentionDays: -5 } }));
    try {
      let days: number | undefined;
      const warnings = captureWarnings(() => { days = loadConfig(home).dormant.retentionDays; });
      expect(days).toBe(180);
      expect(warnings.some((w) => w.includes('retentionDays'))).toBe(true);
    } finally {
      restore();
    }
  });

  it('a faded memory holding a secret is deleted, never kept dormant', async () => {
    const { home, restore } = tmpHome('hippo-dormant-secret-', DORMANT_ON);
    try {
      const secret = aged(createMemory('billing sandbox uses api_key=Zx81Qa92Lm37Pt45Rk for the nightly job', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), 90);
      const plain = aged(createMemory('the billing sandbox nightly job runs at 02:00 UTC', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), 90);
      writeEntry(home, secret);
      writeEntry(home, plain);

      const result = await consolidate(home, { now: new Date() });

      expect(result.removed).toBe(1);
      expect(result.dormant).toBe(1);
      expect(api.listDormant(ctxFor(home)).map((m) => m.id)).toEqual([plain.id]);
      expect(loadAllEntries(home)).toEqual([]);
    } finally {
      restore();
    }
  });
});

describe('a faded credential-tagged memory', () => {
  it('is removed rather than made dormant, and the report says so', async () => {
    const { home, restore } = tmpHome('hippo-dormant-credtag-', DORMANT_ON);
    try {
      const tagged = aged(createMemory('an old note about rotating the staging deploy key', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tags: ['credential'] }), 90);
      writeEntry(home, tagged);

      const result = await consolidate(home, { now: new Date() });

      expect(result.removed).toBe(1);
      expect(result.dormant).toBe(0);
      expect(result.removedIds).toEqual([tagged.id]);
      expect(result.details.some((l) => l.startsWith(`  🗑  removed ${tagged.id} (strength `))).toBe(true);
      expect(api.listDormant(ctxFor(home))).toEqual([]);
      expect(loadAllEntries(home)).toEqual([]);
    } finally {
      restore();
    }
  });
});

describe('dormant retention', () => {
  function storeWithOldDormant(prefix: string, config: string, daysAgo: number) {
    const { home, restore } = tmpHome(prefix, config);
    const entry = createMemory('the retired cron host was called nightly-02', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    const db = openHippoDb(home);
    try {
      insertDormantRow(db, {
        entry,
        strength: 0.01,
        reason: 'decay',
        dormantAt: new Date(Date.now() - daysAgo * DAY_MS).toISOString(),
      });
    } finally {
      closeHippoDb(db);
    }
    return { home, restore, id: entry.id };
  }

  it('sleep deletes a dormant memory once it outlives retentionDays', async () => {
    const { home, restore } = storeWithOldDormant('hippo-dormant-expire-', JSON.stringify({ dormant: { retentionDays: 30 } }), 45);
    try {
      const dry = await consolidate(home, { now: new Date(), dryRun: true });
      expect(dry.dormantExpired).toBe(1);
      expect(countDormantRows(home)).toBe(1);

      const result = await consolidate(home, { now: new Date() });
      expect(result.dormantExpired).toBe(1);
      expect(countDormantRows(home)).toBe(0);
    } finally {
      restore();
    }
  });

  it('keeps a dormant memory inside the window, and forever with retentionDays 0', async () => {
    const inside = storeWithOldDormant('hippo-dormant-inside-', JSON.stringify({ dormant: { retentionDays: 180 } }), 45);
    const forever = storeWithOldDormant('hippo-dormant-forever-', JSON.stringify({ dormant: { retentionDays: 0 } }), 4000);
    try {
      expect((await consolidate(inside.home, { now: new Date() })).dormantExpired).toBe(0);
      expect((await consolidate(forever.home, { now: new Date() })).dormantExpired).toBe(0);
      expect(countDormantRows(inside.home)).toBe(1);
      expect(countDormantRows(forever.home)).toBe(1);
    } finally {
      inside.restore();
      forever.restore();
    }
  });

  it('expires in short transactions, and keeps a row put back to sleep between them', async () => {
    const { home, restore } = tmpHome('hippo-dormant-expire-chunks-', JSON.stringify({ dormant: { retentionDays: 30 } }));
    const ids: string[] = [];
    const db = openHippoDb(home);
    try {
      for (let i = 0; i < 5; i++) {
        const entry = createMemory(`retired cron host number ${i} was called nightly-0${i}`, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
        insertDormantRow(db, { entry, strength: 0.01, reason: 'decay', dormantAt: new Date(Date.now() - 45 * DAY_MS).toISOString() });
        ids.push(entry.id);
      }
    } finally {
      closeHippoDb(db);
    }
    let pauses = 0;
    let kept = '';
    // A zero hold commits after every row; the first gap re-dates a row the run has not reached, as a restore and a new sleep would.
    const pause = async (): Promise<void> => {
      if (pauses++ > 0) return;
      const other = openHippoDb(home);
      try {
        // SAFETY: the seeded table holds rows, and the SELECT returns the single id column.
        kept = (other.prepare(`SELECT id FROM dormant_memories LIMIT 1`).get() as { id: string }).id;
        other.prepare(`UPDATE dormant_memories SET dormant_at = ? WHERE id = ?`).run(new Date().toISOString(), kept);
      } finally {
        closeHippoDb(other);
      }
    };
    try {
      const result = await consolidate(home, { now: new Date(), budget: { ...WRITE_BUDGET, holdMs: 0, pause } });
      expect(result.dormantExpired).toBe(4);
      expect(pauses).toBe(4);
      expect(ids).toContain(kept);
      expect(api.listDormant(ctxFor(home)).map((m) => m.id)).toEqual([kept]);
    } finally {
      restore();
    }
  });

  it('still ages out old dormant memories after the feature is turned off', async () => {
    const { home, restore } = storeWithOldDormant('hippo-dormant-off-expire-', JSON.stringify({ dormant: { enabled: false } }), 400);
    try {
      expect((await consolidate(home, { now: new Date() })).dormantExpired).toBe(1);
    } finally {
      restore();
    }
  });
});

describe('with dormant memories enabled', () => {
  it('sleep moves a faded memory out of active memory instead of deleting it', async () => {
    const { home, restore } = tmpHome('hippo-dormant-move-', DORMANT_ON);
    try {
      const faded = aged(createMemory('the old staging hostname was build-07 before the move', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tags: ['infra'] }), 90);
      const fresh = createMemory('the release checklist lives in docs/release-policy.md', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
      writeEntry(home, faded);
      writeEntry(home, fresh);

      const result = await consolidate(home, { now: new Date() });

      expect(result.removed).toBe(0);
      expect(result.dormant).toBe(1);
      expect(result.details.some((d) => d.includes(faded.id) && d.includes('dormant'))).toBe(true);
      expect(loadAllEntries(home).map((e) => e.id)).toEqual([fresh.id]);
      // The markdown mirror goes too, so a bootstrap of an empty table
      // cannot re-import the row as active.
      expect(entryMirrorFiles(home, faded.id)).toEqual([]);

      const dormant = api.listDormant(ctxFor(home));
      expect(dormant).toHaveLength(1);
      expect(dormant[0].id).toBe(faded.id);
      expect(dormant[0].content).toBe(faded.content);
      expect(dormant[0].tags).toEqual(['infra']);
      expect(dormant[0].reason).toBe('decay');
      expect(dormant[0].strength).toBeLessThan(0.05);
    } finally {
      restore();
    }
  });

  it('a dormant memory never reaches recall or context', async () => {
    const { home, restore } = tmpHome('hippo-dormant-recall-', DORMANT_ON);
    try {
      const faded = aged(createMemory('zanzibar gateway requires the legacy auth header', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), 90);
      writeEntry(home, faded);
      await consolidate(home, { now: new Date() });

      const recalled = api.recall(ctxFor(home), { query: 'zanzibar gateway auth header' });
      expect(recalled.results.map((r) => r.id)).not.toContain(faded.id);
    } finally {
      restore();
    }
  });

  it('a dormant memory sits out every later sleep untouched', async () => {
    const { home, restore } = tmpHome('hippo-dormant-idle-', DORMANT_ON);
    try {
      const faded = aged(createMemory('the old staging hostname was build-07 before the move', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), 90);
      writeEntry(home, faded);
      await consolidate(home, { now: new Date() });
      const before = api.listDormant(ctxFor(home));

      const second = await consolidate(home, { now: new Date(Date.now() + 30 * DAY_MS) });

      expect(second.dormant).toBe(0);
      expect(second.removed).toBe(0);
      expect(api.listDormant(ctxFor(home))).toEqual(before);
    } finally {
      restore();
    }
  });

  it('pinned memories and raw receipts never go dormant', async () => {
    const { home, restore } = tmpHome('hippo-dormant-exempt-', DORMANT_ON);
    try {
      const pinned = aged(createMemory('never force-push to master', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, pinned: true }), 400);
      const receipt = aged(createMemory('slack receipt: the prod deploy failed on the stale cache', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, layer: Layer.Episodic, kind: 'raw' }), 90);
      writeEntry(home, pinned);
      writeEntry(home, receipt);

      const result = await consolidate(home, { now: new Date() });

      expect(result.dormant).toBe(0);
      expect(loadAllEntries(home).map((e) => e.id).sort()).toEqual([pinned.id, receipt.id].sort());
      expect(api.listDormant(ctxFor(home))).toEqual([]);
    } finally {
      restore();
    }
  });

  it('a dry run reports the move but changes nothing', async () => {
    const { home, restore } = tmpHome('hippo-dormant-dry-', DORMANT_ON);
    try {
      const faded = aged(createMemory('the old staging hostname was build-07 before the move', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), 90);
      writeEntry(home, faded);

      const result = await consolidate(home, { now: new Date(), dryRun: true });

      expect(result.dormant).toBe(1);
      expect(result.details.some((l) => l.startsWith(`  💤 dormant ${faded.id} (strength `))).toBe(true);
      expect(loadAllEntries(home).map((e) => e.id)).toEqual([faded.id]);
      expect(countDormantRows(home)).toBe(0);
    } finally {
      restore();
    }
  });

  it('api.sleep reports how many memories went dormant', async () => {
    const { home, restore } = tmpHome('hippo-dormant-sleep-', DORMANT_ON);
    try {
      writeEntry(home, aged(createMemory('the old staging hostname was build-07 before the move', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), 90));

      const result = await api.sleep(ctxFor(home), { noShare: true });

      expect(result.dormant).toBe(1);
      expect(result.removed).toBe(0);
    } finally {
      restore();
    }
  });
});

describe('listing, restoring and forgetting dormant memories', () => {
  async function storeWithDormant(prefix: string, contents: string[]) {
    const { home, restore } = tmpHome(prefix, DORMANT_ON);
    const ids: string[] = [];
    for (const content of contents) {
      const entry = aged(createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), 90);
      writeEntry(home, entry);
      ids.push(entry.id);
    }
    await consolidate(home, { now: new Date() });
    return { home, restore, ids };
  }

  it('search matches every term, case-insensitively, and treats % and _ literally', async () => {
    const { home, restore, ids } = await storeWithDormant('hippo-dormant-search-', [
      'Deploys to Staging need the VPN profile',
      'staging database snapshots rotate weekly',
      'coverage stays at 100% for the parser',
      'the env var is named HIPPO_TENANT',
    ]);
    try {
      expect(api.listDormant(ctxFor(home), { query: 'staging vpn' }).map((m) => m.id)).toEqual([ids[0]]);
      expect(api.listDormant(ctxFor(home), { query: 'STAGING' })).toHaveLength(2);
      expect(api.listDormant(ctxFor(home), { query: '100%' }).map((m) => m.id)).toEqual([ids[2]]);
      expect(api.listDormant(ctxFor(home), { query: 'hippo_tenant' }).map((m) => m.id)).toEqual([ids[3]]);
      // As LIKE wildcards these would match "staging database" and
      // "to Staging need"; taken literally they match nothing.
      expect(api.listDormant(ctxFor(home), { query: 'g_d' })).toEqual([]);
      expect(api.listDormant(ctxFor(home), { query: 'to%need' })).toEqual([]);
      expect(api.listDormant(ctxFor(home), { limit: 2 })).toHaveLength(2);
    } finally {
      restore();
    }
  });

  it('restore brings a memory back as if just recalled, and it survives the next sleep', async () => {
    const { home, restore, ids } = await storeWithDormant('hippo-dormant-restore-', [
      'zanzibar gateway requires the legacy auth header',
    ]);
    try {
      const before = Date.now();
      const restored = api.restoreDormant(ctxFor(home), ids[0]);

      expect(restored.id).toBe(ids[0]);
      expect(entryMirrorFiles(home, ids[0])).toHaveLength(1);
      expect(Date.parse(restored.last_retrieved)).toBeGreaterThanOrEqual(before - 1000);
      expect(calculateStrength(restored, new Date())).toBeGreaterThan(0.9);
      expect(api.listDormant(ctxFor(home))).toEqual([]);
      expect(api.recall(ctxFor(home), { query: 'zanzibar gateway auth header' }).results.map((r) => r.id)).toContain(ids[0]);

      const next = await consolidate(home, { now: new Date() });
      expect(next.dormant).toBe(0);
      expect(loadAllEntries(home).map((e) => e.id)).toContain(ids[0]);

      // The restore is logged as a "forgot it, then needed it" label.
      const db = openHippoDb(home);
      try {
        // SAFETY: rows' shape matches the two columns named in the SELECT.
        const rows = db.prepare(`SELECT target_id, metadata_json FROM audit_log WHERE op = 'dormant_restore'`).all() as Array<{ target_id: string; metadata_json: string }>;
        expect(rows.map((r) => r.target_id)).toEqual([ids[0]]);
        // SAFETY: metadata_json is written by appendAuditEvent from a JSON object.
        const meta = JSON.parse(rows[0].metadata_json) as { reason: string; daysDormant: number };
        expect(meta.reason).toBe('decay');
        expect(meta.daysDormant).toBeGreaterThanOrEqual(0);
      } finally {
        closeHippoDb(db);
      }
    } finally {
      restore();
    }
  });

  it('restore refuses an unknown id, another tenant\'s memory, and an id that is already active', async () => {
    const { home, restore, ids } = await storeWithDormant('hippo-dormant-guard-', [
      'zanzibar gateway requires the legacy auth header',
    ]);
    try {
      expect(() => api.restoreDormant(ctxFor(home), 'mem_doesnotexist')).toThrow(/dormant memory not found/);
      expect(() => api.restoreDormant(ctxFor(home, 'tenant-b'), ids[0])).toThrow(/dormant memory not found/);
      expect(api.listDormant(ctxFor(home, 'tenant-b'))).toEqual([]);

      // Same id written back as active (e.g. by an old binary): restore must
      // not overwrite the live row with the older snapshot.
      const live = { ...createMemory('live copy under the same id', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), id: ids[0] };
      writeEntry(home, live);
      expect(() => api.restoreDormant(ctxFor(home), ids[0])).toThrow(/already active/);
      expect(api.listDormant(ctxFor(home)).map((m) => m.id)).toEqual([ids[0]]);
    } finally {
      restore();
    }
  });

  it('rejecting a value also purges its dormant copies', async () => {
    const { home, restore, ids } = await storeWithDormant('hippo-dormant-rejected-', [
      'the staging api key lives in the shared vault entry',
    ]);
    try {
      await api.reject(ctxFor(home), { value: 'the staging api key lives in the shared vault entry', reason: 'stale secret pointer' });
      // A rejected value may not linger in dormant storage either.
      expect(api.listDormant(ctxFor(home))).toEqual([]);
      expect(() => api.restoreDormant(ctxFor(home), ids[0])).toThrow(/dormant memory not found/);
    } finally {
      restore();
    }
  });

  it('restore honours a tombstone that skipped the purge, and keeps the dormant copy in place', async () => {
    const { home, restore, ids } = await storeWithDormant('hippo-dormant-guard-old-', [
      'the staging api key lives in the shared vault entry',
    ]);
    try {
      // Simulate a tombstone written without the dormant purge (an old binary
      // sharing the store): insert the tombstone row directly.
      const db = openHippoDb(home);
      try {
        insertRejectedValue(db, {
          tenantId: 'default',
          digest: rejectionDigest('the staging api key lives in the shared vault entry'),
          reason: 'old binary',
          rejectedBy: 'test',
          rejectedAt: new Date().toISOString(),
          sourceMemoryId: null,
          normalizedChars: 10,
        });
      } finally {
        closeHippoDb(db);
      }
      expect(() => api.restoreDormant(ctxFor(home), ids[0])).toThrow(RejectedValueError);
      expect(api.listDormant(ctxFor(home)).map((m) => m.id)).toEqual([ids[0]]);
      expect(loadAllEntries(home).map((e) => e.id)).not.toContain(ids[0]);
      expect(auditRows(home, 'reject_refusal').map((e) => [e.targetId, e.actor])).toEqual([[ids[0], 'test']]);
    } finally {
      restore();
    }
  });

  it('another person\'s dormant personal row reads as missing to every call, and its owner keeps it', async () => {
    const { home, restore } = tmpHome('hippo-dormant-personal-', DORMANT_ON);
    try {
      const mine = aged(createMemory('the quillfen alias is mine alone', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, scope: 'personal:private:oid-a' }), 90);
      const team = aged(createMemory('the quillfen gateway serves the whole team', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), 90);
      writeEntry(home, mine);
      writeEntry(home, team);
      await consolidate(home, { now: new Date() });
      const as = (owner: string | undefined, role: 'admin' | 'member'): api.Context =>
        ({ hippoRoot: home, tenantId: 'default', actor: owner === undefined ? { subject: 'adm', role } : { subject: owner, role, owner } });
      for (const ctx of [as('oid-b', 'member'), as(undefined, 'admin'), as('oid-b', 'admin')]) {
        expect(api.listDormant(ctx).map((m) => m.id)).toEqual([team.id]);
        expect(api.isDormant(ctx, team.id)).toBe(true);
        expect(api.isDormant(ctx, mine.id)).toBe(false);
        expect(() => api.restoreDormant(ctx, mine.id)).toThrow(`dormant memory not found: ${mine.id}`);
        expect(() => api.forgetDormant(ctx, mine.id)).toThrow(`dormant memory not found: ${mine.id}`);
      }
      const owner = as('oid-a', 'member');
      expect(api.listDormant(owner).map((m) => m.id).sort()).toEqual([mine.id, team.id].sort());
      expect(api.isDormant(owner, mine.id)).toBe(true);
      expect(api.restoreDormant(owner, mine.id).scope).toBe('personal:private:oid-a');
    } finally {
      restore();
    }
  });

  it('forget deletes a dormant memory permanently, tenant-scoped', async () => {
    const { home, restore, ids } = await storeWithDormant('hippo-dormant-forget-', [
      'zanzibar gateway requires the legacy auth header',
    ]);
    try {
      expect(() => api.forgetDormant(ctxFor(home, 'tenant-b'), ids[0])).toThrow(/dormant memory not found/);
      api.forgetDormant(ctxFor(home), ids[0]);
      expect(api.listDormant(ctxFor(home))).toEqual([]);
      expect(() => api.restoreDormant(ctxFor(home), ids[0])).toThrow(/dormant memory not found/);
      expect(auditRows(home, 'forget').map((e) => [e.targetId, e.actor, e.metadata])).toEqual([[ids[0], 'test', { dormant: true }]]);
      // Counted like forget and archiveRaw (review finding on PR #227).
      expect(Number(loadStats(home).total_forgotten)).toBe(1);
    } finally {
      restore();
    }
  });
});

/** Rows of `table` that still point at `memoryId`. */
function linkedRows(home: string, table: string, memoryId: string): number {
  const db = openHippoDb(home);
  try {
    // SAFETY: row's shape matches the single aliased COUNT column in the SELECT.
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE memory_id = ?`).get(memoryId) as { n: number };
    return row.n;
  } finally {
    closeHippoDb(db);
  }
}

const objectSavers: [string, string, (home: string) => { memoryId: string | null }][] = [
  ['decision', 'decisions', (home) => saveDecision(home, 'default', { decisionText: 'we release on Tuesdays after the staging soak' })],
  ['incident', 'incidents', (home) => saveIncident(home, 'default', { incidentText: 'the billing cron charged twice on the 1st' })],
  ['process', 'processes', (home) => saveProcess(home, 'default', { processName: 'Release', steps: ['tag', 'publish'] })],
  ['policy', 'policies', (home) => savePolicy(home, 'default', { policyName: 'RetryPolicy', policyText: 'retry up to 3x' })],
  ['skill', 'skills', (home) => saveSkill(home, 'default', { skillName: 'Run tests', instructions: 'npm test before commit' })],
  ['project brief', 'project_briefs', (home) => saveProjectBrief(home, 'default', { repo: 'acme/billing', summary: 'billing service for Acme' })],
  ['customer note', 'customer_notes', (home) => saveCustomerNote(home, 'default', { customer: 'Acme', note: 'renewal is due in March' })],
  ['prediction', 'predictions', (home) => savePrediction(home, 'default', { classTag: 'migration-effort', claimText: 'the migration takes two days' })],
];

describe('memories that back a first-class object', () => {
  it.each(objectSavers)('sleep keeps a faded %s memory active, so the object keeps its link', async (_kind, table, save) => {
    const { home, restore } = tmpHome('hippo-dormant-linked-', '{}');
    try {
      const memoryId = save(home).memoryId!;
      // Fade it far below the threshold, as years without recall would.
      const faded = aged(loadAllEntries(home).find((e) => e.id === memoryId)!, 3000);
      writeEntry(home, faded);
      expect(calculateStrength(faded)).toBeLessThan(0.05);

      const result = await consolidate(home);
      expect(result.dormant).toBe(0);
      expect(result.removed).toBe(0);
      expect(loadAllEntries(home).map((e) => e.id)).toContain(memoryId);
      expect(linkedRows(home, table, memoryId)).toBe(1);
    } finally {
      restore();
    }
  });

  it('sleep stops, retiring nothing, when it cannot read an object table', async () => {
    const { home, restore } = tmpHome('hippo-dormant-unreadable-', '{}');
    try {
      const faded = aged(createMemory('the old staging hostname was build-02', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), 3000);
      writeEntry(home, faded);
      const db = openHippoDb(home);
      try {
        db.exec('ALTER TABLE incidents RENAME COLUMN memory_id TO memory_ref');
      } finally {
        closeHippoDb(db);
      }

      await expect(consolidate(home)).rejects.toThrow(/no such column/);
      expect(loadAllEntries(home).map((e) => e.id)).toContain(faded.id);
    } finally {
      restore();
    }
  });

  it('covers every object table whose memory link a delete would null', () => {
    const { home, restore } = tmpHome('hippo-dormant-schema-', '{}');
    const db = openHippoDb(home);
    try {
      // SAFETY: each row is the single aliased TEXT column in the SELECT.
      const rows = db.prepare(`SELECT m.name AS name FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f
        WHERE m.type = 'table' AND f."table" = 'memories' AND f.on_delete = 'SET NULL'`).all() as { name: string }[];
      // Graph rows drop their memory pointer by design (src/db/index.ts, the entities and relations schema).
      const objectTables = rows.map((r) => r.name).filter((t) => t !== 'entities' && t !== 'relations');
      expect([...MEMORY_BACKED_TABLES].sort()).toEqual(objectTables.sort());
    } finally {
      closeHippoDb(db);
      restore();
    }
  });
});

describe('hippo dormant CLI', () => {
  const CLI_PATH = join(__dirname, '..', 'dist', 'cli.js');

  function runCli(cwd: string, ...args: string[]) {
    try {
      const out = execFileSync(process.execPath, [CLI_PATH, ...args], {
        cwd, env: { ...process.env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { out, status: 0 };
    } catch (e) {
      // SAFETY: execFileSync attaches stdout/stderr/status to the thrown Error
      // on a non-zero child exit (Node child_process sync error contract).
      const err = e as { stdout?: string; stderr?: string; status?: number };
      return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, status: err.status ?? 1 };
    }
  }

  it('lists, restores and forgets dormant memories', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'hippo-dormant-cli-'));
    const hippoRoot = join(workspace, '.hippo');
    try {
      initStore(hippoRoot);
      writeFileSync(join(hippoRoot, 'config.json'), DORMANT_ON, 'utf8');
      const keep = aged(createMemory('zanzibar gateway requires the legacy auth header', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), 90);
      const drop = aged(createMemory('the old staging hostname was build-07 before the move', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), 90);
      writeEntry(hippoRoot, keep);
      writeEntry(hippoRoot, drop);
      await consolidate(hippoRoot, { now: new Date() });

      const list = runCli(workspace, 'dormant');
      expect(list.status).toBe(0);
      expect(list.out).toContain('2 dormant memories');
      expect(list.out).toContain(keep.id);

      const search = runCli(workspace, 'dormant', 'zanzibar', '--json');
      expect(search.status).toBe(0);
      // SAFETY: `hippo dormant --json` prints a JSON object with a `dormant` array (handleDormant).
      const parsed = JSON.parse(search.out) as { dormant: Array<{ id: string }> };
      expect(parsed.dormant.map((m) => m.id)).toEqual([keep.id]);

      const restored = runCli(workspace, 'dormant', 'restore', keep.id);
      expect(restored.status).toBe(0);
      expect(restored.out).toContain(`Restored ${keep.id}`);

      const forgotten = runCli(workspace, 'dormant', 'forget', drop.id);
      expect(forgotten.status).toBe(0);
      expect(forgotten.out).toContain(`Forgot dormant memory ${drop.id}`);

      expect(runCli(workspace, 'dormant').out).toContain('No dormant memories');
      expect(runCli(workspace, 'dormant', 'restore', drop.id).status).not.toBe(0);

      // `hippo forget` on a dormant id points at the dormant command instead
      // of a bare "not found".
      writeEntry(hippoRoot, aged(createMemory('a third faded memory about the retired cron host', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), 90));
      await consolidate(hippoRoot, { now: new Date() });
      const [third] = api.listDormant(ctxFor(hippoRoot));
      const hint = runCli(workspace, 'forget', third.id);
      expect(hint.status).not.toBe(0);
      expect(hint.out).toContain(`hippo dormant forget ${third.id}`);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
