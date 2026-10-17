/**
 * Runtime tests for api.sleep (Episode A, Task 4).
 *
 * Validates the documented contract of the narrowed sleep API:
 *   - dryRun previews dedup/audit, then returns before share/ambient
 *   - non-dry-run runs the full pure-storage pipeline
 *   - empty store returns the well-formed zero SleepResult
 *
 * The noShare contract lives in api-sleep-secret-skip.test.ts, over rows that would otherwise share.
 * Auto-learn is intentionally NOT covered here — it stays CLI-side per the
 * option-B factoring (uses process.cwd() / os.homedir() which are not
 * api-layer concerns).
 *
 * Real-DB per project convention. Each test isolates BOTH:
 *   - local hippoRoot: mkdtempSync (passed as ctx.hippoRoot)
 *   - global hippoRoot: HIPPO_HOME env override (autoShare promotes to global)
 * Restores HIPPO_HOME on cleanup. Per _real-store-guard.ts conventions.
 */

import type { FullContext } from './_helpers/api-ctx.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import { queryAuditEvents } from '../src/store/audit.js';
import { remember, sleep, getContext } from '../src/api/index.js';
import { apiCtx } from './_helpers/api-ctx.js';
import { makeRoot } from './_helpers/make-root.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

// The 'consolidate' audit op's metadata is always the flat scalar phase-counter
// object built at the appendAuditEvent call site for that op in src/api/index.ts --
// never nested objects or arrays.
type AuditMetadataValue = string | number | boolean | null;

function tmpHome() {
  const home = makeRoot('api-sleep');
  // api.sleep's auto-share phase promotes memories to the GLOBAL store
  // (resolved via HIPPO_HOME). Without per-test override, those writes
  // leak into the shared baseline HIPPO_HOME and fail the isolation guard.
  const origHippoHome = process.env.HIPPO_HOME;
  vi.stubEnv('HIPPO_HOME', home);
  return {
    home,
    restore: () => {
      rmSync(home, { recursive: true, force: true });
      if (origHippoHome !== undefined) {
        vi.stubEnv('HIPPO_HOME', origHippoHome);
      } else {
        vi.stubEnv('HIPPO_HOME', undefined);
      }
    },
  };
}

describe('api.sleep', () => {
  it('dryRun previews dedup/audit, skips share/ambient, and deletes nothing', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      await remember(ctx, { content: 'sleep-dry-mem-1', kind: 'distilled' });

      const result = await sleep(ctx, { dryRun: true });

      expect(result.dryRun).toBe(true);
      expect(result.removed).toBe(0);
      expect((await getContext(ctx, { budget: 1500 })).entries).toHaveLength(1);
      // H10: the preview reports what a real sleep would dedupe and audit.
      expect(result.deduped).toBeUndefined();
      expect(result.audit).toEqual({ errorsRemoved: 0, warningCount: 1 });
      expect(result.shared).toBeUndefined();
      expect(result.ambient).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('returns a well-formed zero SleepResult on an empty store', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });

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
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      for (let i = 0; i < 5; i++) {
        await remember(ctx, {
          content: `unique memory ${i} with some distinct content here for testing`,
          kind: 'distilled',
        });
      }

      const result = await sleep(ctx, { dryRun: false });

      expect(result.dryRun).toBe(false);
      expect(Number.isInteger(result.active)).toBe(true);
      expect(Number.isInteger(result.removed)).toBe(true);
      expect(Number.isInteger(result.mergedEpisodic)).toBe(true);
      expect(Number.isInteger(result.newSemantic)).toBe(true);
      expect(Array.isArray(result.details)).toBe(true);
    } finally {
      restore();
    }
  });

  // v1.11.5: consolidate audit emission
  it('emits exactly one consolidate audit_log row per invocation with phase counters', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      await remember(ctx, { content: 'before-sleep-1' });
      await remember(ctx, { content: 'before-sleep-2' });

      await sleep(ctx, { dryRun: false, noShare: true });

      const db = openHippoDb(home);
      const rows = queryAuditEvents(db, { tenantId: '__host__', op: 'consolidate' });
      closeHippoDb(db);

      expect(rows.length).toBe(1);
      expect(rows[0]?.actor).toBe('cli');
      expect(rows[0]?.op).toBe('consolidate');
      // Metadata should carry phase counters with the keys we expect.
      // SAFETY: see the AuditMetadataValue comment above -- consolidate metadata is
      // always a flat scalar object.
      const meta = rows[0]?.metadata as Record<string, AuditMetadataValue>;
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
});
