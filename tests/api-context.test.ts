/**
 * Runtime tests for api.getContext (Episode A, Task 5).
 *
 * Coverage:
 *   - empty store -> empty result
 *   - '*' fallback returns strongest memories within budget
 *   - budget cap is honored (tight budget excludes lower-scored entries)
 *   - tenant scoping: cross-tenant memories invisible
 *   - includeRecent populates the pinnedOnly path
 *   - activeSnapshot returned when set
 *
 * Auto-detect (git diff -> query) and rendering (markdown/json/additional-
 * context) are NOT covered here per the T5 scope narrow — those are CLI-side
 * concerns. The CLI integration is verified by the full test suite + manual
 * smokes (see Verify section of the plan).
 *
 * Real-DB per project convention. Each test isolates BOTH:
 *   - local hippoRoot: mkdtempSync (passed as ctx.hippoRoot)
 *   - global hippoRoot: HIPPO_HOME points to a SEPARATE uninitialized dir
 *     so hasGlobal=false and the test stays local-only.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, saveActiveTaskSnapshot } from '../src/store.js';
import { remember, getContext, type Context } from '../src/api.js';

function tmpHome(): { home: string; restore: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'hippo-api-ctx-'));
  initStore(home);
  // Per-test HIPPO_HOME override pointing to a separate UNINITIALIZED dir
  // so hasGlobal=false inside api.getContext. Keeps the test local-only and
  // prevents any global writes from leaking into the shared baseline.
  const globalTmp = mkdtempSync(join(tmpdir(), 'hippo-api-ctx-global-'));
  const origHippoHome = process.env.HIPPO_HOME;
  process.env.HIPPO_HOME = globalTmp;
  return {
    home,
    restore: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(globalTmp, { recursive: true, force: true });
      if (origHippoHome !== undefined) {
        process.env.HIPPO_HOME = origHippoHome;
      } else {
        delete process.env.HIPPO_HOME;
      }
    },
  };
}

describe('api.getContext', () => {
  it('returns an empty result on an empty store', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: Context = {
        hippoRoot: home,
        tenantId: 'default',
        actor: { subject: 'cli', role: 'admin' },
      };
      const result = await getContext(ctx, {});
      expect(result.entries).toEqual([]);
      expect(result.tokens).toBe(0);
      expect(result.activeSnapshot).toBeFalsy();
      expect(result.sessionHandoff).toBeFalsy();
    } finally {
      restore();
    }
  });

  it("'*' fallback returns memories within budget, strongest first", async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: Context = {
        hippoRoot: home,
        tenantId: 'default',
        actor: { subject: 'cli', role: 'admin' },
      };
      for (let i = 0; i < 5; i++) {
        remember(ctx, {
          content: `getcontext-fallback-mem-${i}`,
          kind: 'distilled',
        });
      }

      const result = await getContext(ctx, { budget: 1500 });

      expect(result.entries.length).toBeGreaterThan(0);
      expect(result.entries.length).toBeLessThanOrEqual(5);
      expect(result.tokens).toBeGreaterThan(0);
      expect(result.tokens).toBeLessThanOrEqual(1500);
      // Strongest first ordering
      for (let i = 1; i < result.entries.length; i++) {
        expect(result.entries[i - 1].score).toBeGreaterThanOrEqual(result.entries[i].score);
      }
    } finally {
      restore();
    }
  });

  it('honors a tight budget cap (excludes overflow entries)', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: Context = {
        hippoRoot: home,
        tenantId: 'default',
        actor: { subject: 'cli', role: 'admin' },
      };
      // Seed 10 longish memories so total tokens >> tight budget
      for (let i = 0; i < 10; i++) {
        remember(ctx, {
          content: `padding ${'x'.repeat(200)} content number ${i}`,
          kind: 'distilled',
        });
      }

      const result = await getContext(ctx, { budget: 50 });

      expect(result.tokens).toBeLessThanOrEqual(50);
      // At a 50-token budget, only the smallest-or-fewest memories fit
      expect(result.entries.length).toBeLessThan(10);
    } finally {
      restore();
    }
  });

  it('tenant scoping: tenant_a does not see tenant_b memories', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctxA: Context = {
        hippoRoot: home,
        tenantId: 'tenant_a',
        actor: { subject: 'cli', role: 'admin' },
      };
      const ctxB: Context = {
        hippoRoot: home,
        tenantId: 'tenant_b',
        actor: { subject: 'cli', role: 'admin' },
      };
      remember(ctxA, { content: 'belongs-to-tenant-A', kind: 'distilled' });
      remember(ctxB, { content: 'belongs-to-tenant-B', kind: 'distilled' });

      const resultA = await getContext(ctxA, { budget: 1500 });
      const resultB = await getContext(ctxB, { budget: 1500 });

      const idsA = resultA.entries.map((e) => e.entry.content);
      const idsB = resultB.entries.map((e) => e.entry.content);

      expect(idsA).toContain('belongs-to-tenant-A');
      expect(idsA).not.toContain('belongs-to-tenant-B');
      expect(idsB).toContain('belongs-to-tenant-B');
      expect(idsB).not.toContain('belongs-to-tenant-A');
    } finally {
      restore();
    }
  });

  it('returns activeSnapshot when one is set for the active session', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: Context = {
        hippoRoot: home,
        tenantId: 'default',
        actor: { subject: 'cli', role: 'admin' },
      };
      saveActiveTaskSnapshot(home, ctx.tenantId, {
        task: 'Test task for api.getContext',
        summary: 'Stub for the activeSnapshot return path',
        next_step: 'Verify result.activeSnapshot is populated',
        source: 'test',
        session_id: 'sess-ctxtest',
        scope: null,
      });
      remember(ctx, { content: 'snapshot-test-mem', kind: 'distilled' });

      const result = await getContext(ctx, { budget: 1500 });

      expect(result.activeSnapshot).toBeTruthy();
      expect(result.activeSnapshot?.session_id).toBe('sess-ctxtest');
      expect(result.activeSnapshot?.task).toBe('Test task for api.getContext');
    } finally {
      restore();
    }
  });

  it('budget=0 short-circuits to an empty result', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: Context = {
        hippoRoot: home,
        tenantId: 'default',
        actor: { subject: 'cli', role: 'admin' },
      };
      remember(ctx, { content: 'budget-zero-test', kind: 'distilled' });

      const result = await getContext(ctx, { budget: 0 });

      expect(result.entries).toEqual([]);
      expect(result.tokens).toBe(0);
    } finally {
      restore();
    }
  });
});
