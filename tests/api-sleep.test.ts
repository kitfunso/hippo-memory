/**
 * Runtime tests for api.sleep (Episode A, Task 4).
 *
 * Validates the documented contract of the narrowed sleep API:
 *   - dryRun returns early after consolidate; dedup/audit/share/ambient skipped
 *   - non-dry-run runs the full pure-storage pipeline
 *   - empty store returns the well-formed zero SleepResult
 *   - noShare prevents auto-share regardless of config.autoShareOnSleep
 *
 * Auto-learn is intentionally NOT covered here — it stays CLI-side per the
 * option-B factoring (uses process.cwd() / os.homedir() which are not
 * api-layer concerns).
 *
 * Real-DB per project convention. Each test isolates BOTH:
 *   - local hippoRoot: mkdtempSync (passed as ctx.hippoRoot)
 *   - global hippoRoot: HIPPO_HOME env override (autoShare promotes to global)
 * Restores HIPPO_HOME on cleanup. Per _real-store-guard.ts conventions.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { queryAuditEvents } from '../src/audit.js';
import { remember, sleep, type Context } from '../src/api.js';

function tmpHome(): { home: string; restore: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'hippo-api-sleep-'));
  initStore(home);
  // api.sleep's auto-share phase promotes memories to the GLOBAL store
  // (resolved via HIPPO_HOME). Without per-test override, those writes
  // leak into the shared baseline HIPPO_HOME and fail the isolation guard.
  const origHippoHome = process.env.HIPPO_HOME;
  process.env.HIPPO_HOME = home;
  return {
    home,
    restore: () => {
      rmSync(home, { recursive: true, force: true });
      if (origHippoHome !== undefined) {
        process.env.HIPPO_HOME = origHippoHome;
      } else {
        delete process.env.HIPPO_HOME;
      }
    },
  };
}

describe('api.sleep', () => {
  it('dryRun returns SleepResult.dryRun=true and skips dedup/audit/share/ambient', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: Context = {
        hippoRoot: home,
        tenantId: 'default',
        actor: 'cli',
      };
      remember(ctx, { content: 'sleep-dry-mem-1', kind: 'distilled' });

      const result = await sleep(ctx, { dryRun: true });

      expect(result.dryRun).toBe(true);
      // dryRun returns immediately after consolidate; no other phases run.
      expect(result.deduped).toBeUndefined();
      expect(result.audit).toBeUndefined();
      expect(result.shared).toBeUndefined();
      expect(result.ambient).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('returns a well-formed zero SleepResult on an empty store', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: Context = {
        hippoRoot: home,
        tenantId: 'default',
        actor: 'cli',
      };

      const result = await sleep(ctx, { dryRun: false });

      expect(result.dryRun).toBe(false);
      expect(result.active).toBe(0);
      expect(result.removed).toBe(0);
      expect(result.mergedEpisodic).toBe(0);
      expect(result.newSemantic).toBe(0);
      // No entries -> dedup pairs empty, audit issues empty
      expect(result.deduped).toBeUndefined();
      expect(result.audit).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('runs the full pipeline on a populated store (counts present and numeric)', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: Context = {
        hippoRoot: home,
        tenantId: 'default',
        actor: 'cli',
      };
      for (let i = 0; i < 5; i++) {
        remember(ctx, {
          content: `unique memory ${i} with some distinct content here for testing`,
          kind: 'distilled',
        });
      }

      const result = await sleep(ctx, { dryRun: false });

      expect(result.dryRun).toBe(false);
      expect(typeof result.active).toBe('number');
      expect(typeof result.removed).toBe('number');
      expect(typeof result.mergedEpisodic).toBe('number');
      expect(typeof result.newSemantic).toBe('number');
      expect(Array.isArray(result.details)).toBe(true);
    } finally {
      restore();
    }
  });

  it('noShare prevents the auto-share phase (shared remains undefined)', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: Context = {
        hippoRoot: home,
        tenantId: 'default',
        actor: 'cli',
      };
      remember(ctx, {
        content: 'high-value-pattern that might trigger auto-share',
        kind: 'distilled',
      });

      const result = await sleep(ctx, { dryRun: false, noShare: true });

      expect(result.shared).toBeUndefined();
    } finally {
      restore();
    }
  });

  // v1.11.5: consolidate audit emission
  it('emits exactly one consolidate audit_log row per invocation with phase counters', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: Context = { hippoRoot: home, tenantId: 'default', actor: 'cli' };
      remember(ctx, { content: 'before-sleep-1' });
      remember(ctx, { content: 'before-sleep-2' });

      await sleep(ctx, { dryRun: false, noShare: true });

      const db = openHippoDb(home);
      const rows = queryAuditEvents(db, { tenantId: 'default', op: 'consolidate' });
      closeHippoDb(db);

      expect(rows.length).toBe(1);
      expect(rows[0]?.actor).toBe('cli');
      expect(rows[0]?.op).toBe('consolidate');
      // Metadata should carry phase counters with the keys we expect.
      const meta = rows[0]?.metadata as Record<string, unknown>;
      expect(meta).toBeDefined();
      expect(meta).toHaveProperty('consolidationCount');
      expect(meta).toHaveProperty('dedupCount');
      expect(meta).toHaveProperty('auditDeletedCount');
      expect(meta).toHaveProperty('ambientTotal');
      expect(meta.dryRun).toBe(false);
      expect(meta.noShare).toBe(true);
      expect(meta.partial).toBe(false);
    } finally {
      restore();
    }
  });

  it('dryRun also emits one consolidate audit row (with dryRun:true)', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: Context = { hippoRoot: home, tenantId: 'default', actor: 'cli' };
      remember(ctx, { content: 'dry-run-target' });

      await sleep(ctx, { dryRun: true });

      const db = openHippoDb(home);
      const rows = queryAuditEvents(db, { tenantId: 'default', op: 'consolidate' });
      closeHippoDb(db);

      expect(rows.length).toBe(1);
      const meta = rows[0]?.metadata as Record<string, unknown>;
      expect(meta.dryRun).toBe(true);
      expect(meta.partial).toBe(false);
    } finally {
      restore();
    }
  });

  it('actor field threads through from ctx (non-cli actor surfaces in audit row)', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: Context = {
        hippoRoot: home,
        tenantId: 'default',
        actor: 'api_key:hk_test_xyz',
      };
      remember(ctx, { content: 'mcp-actor-target' });

      await sleep(ctx, { dryRun: true });

      const db = openHippoDb(home);
      const rows = queryAuditEvents(db, { tenantId: 'default', op: 'consolidate' });
      closeHippoDb(db);

      expect(rows.length).toBe(1);
      expect(rows[0]?.actor).toBe('api_key:hk_test_xyz');
    } finally {
      restore();
    }
  });

  // NOTE: a partial-failure path test (assert partial:true + errorMessage when
  // a phase throws) was attempted in v1.11.5 but the api.sleep pipeline is
  // resilient enough that the obvious sabotage (rm -rf .hippo mid-test) does
  // not produce a throw — openHippoDb auto-creates state. The path IS reachable
  // (the try/catch/finally in api.sleep correctly preserves phaseError and
  // logs audit-emit failures separately, per independent-review HIGH fix).
  // Tracked in TODOS.md for v1.12.0: forcing a deterministic mid-phase throw
  // requires either a DI seam (e.g. inject the phase helpers) or a fault-injection
  // hook in db.ts. Out of v1.11.5 scope; documented contract suffices.
});
