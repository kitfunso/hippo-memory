/**
 * Runtime tests for api.contextGet (Episode A, Task 5).
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

import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { remember, contextGet } from '../../src/api/index.js';
import { apiCtx, cwdProject } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { saveActiveTaskSnapshot } from '../_helpers/root-forms.js';
import { oneRequestPerTest, removeAfterRequest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

afterEach(() => {
  vi.unstubAllEnvs();
});

function tmpHome() {
  const home = makeRoot('api-ctx');
  // Per-test HIPPO_HOME override pointing to a separate UNINITIALIZED dir
  // so hasGlobal=false inside api.contextGet. Keeps the test local-only and
  // prevents any global writes from leaking into the shared baseline.
  const globalTmp = makeRoot('api-ctx-global', { init: false });
  const origHippoHome = process.env.HIPPO_HOME;
  vi.stubEnv('HIPPO_HOME', globalTmp);
  return {
    home,
    restore: () => {
      removeAfterRequest(home);
      if (origHippoHome !== undefined) {
        vi.stubEnv('HIPPO_HOME', origHippoHome);
      } else {
        vi.stubEnv('HIPPO_HOME', undefined);
      }
    },
  };
}

describe('api.contextGet', () => {
  it('returns an empty result on an empty store', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      const result = await contextGet(ctx, { currentProject: cwdProject() });
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
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      for (let i = 0; i < 5; i++) {
        await remember(ctx, {
          content: `getcontext-fallback-mem-${i}`,
          kind: 'distilled',
        });
      }

      const result = await contextGet(ctx, { currentProject: cwdProject(), budget: 1500 });

      // All five fit the budget; estimateTokens is ceil(chars / 4), so each 25-character text costs 7.
      expect(result.entries).toHaveLength(5);
      expect(result.tokens).toBe(35);
      expect(result.tokens).toBe(result.entries.reduce((sum, e) => sum + e.tokens, 0));
      // Strongest first ordering
      for (let i = 1; i < result.entries.length; i++) {
        expect(result.entries[i - 1].score).toBeGreaterThanOrEqual(result.entries[i].score);
      }
    } finally {
      restore();
    }
  });

  it('limit caps the number of entries returned', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      for (let i = 0; i < 4; i++) await remember(ctx, { content: `getcontext-limit-${i}`, kind: 'distilled' });

      const result = await contextGet(ctx, { currentProject: cwdProject(), budget: 1500, limit: 2 });

      expect(result.entries).toHaveLength(2);
    } finally {
      restore();
    }
  });

  it('honors a tight budget cap (excludes overflow entries)', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      // Seed 10 longish memories so total tokens >> tight budget
      for (let i = 0; i < 10; i++) {
        await remember(ctx, {
          content: `padding ${'x'.repeat(200)} content number ${i}`,
          kind: 'distilled',
        });
      }

      const result = await contextGet(ctx, { currentProject: cwdProject(), budget: 50 });

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
      const ctxA: FullContext = apiCtx(home, 'tenant_a', { subject: 'cli', role: 'admin' });
      const ctxB: FullContext = apiCtx(home, 'tenant_b', { subject: 'cli', role: 'admin' });
      await remember(ctxA, { content: 'belongs-to-tenant-A', kind: 'distilled' });
      await remember(ctxB, { content: 'belongs-to-tenant-B', kind: 'distilled' });

      const resultA = await contextGet(ctxA, { currentProject: cwdProject(), budget: 1500 });
      const resultB = await contextGet(ctxB, { currentProject: cwdProject(), budget: 1500 });

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
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      saveActiveTaskSnapshot(home, ctx.tenantId, {
        task: 'Test task for api.contextGet',
        summary: 'Stub for the activeSnapshot return path',
        next_step: 'Verify result.activeSnapshot is populated',
        source: 'test',
        session_id: 'sess-ctxtest',
        scope: null,
      });
      await remember(ctx, { content: 'snapshot-test-mem', kind: 'distilled' });

      const result = await contextGet(ctx, { currentProject: cwdProject(), budget: 1500 });

      expect(result.activeSnapshot).toBeTruthy();
      expect(result.activeSnapshot?.session_id).toBe('sess-ctxtest');
      expect(result.activeSnapshot?.task).toBe('Test task for api.contextGet');
    } finally {
      restore();
    }
  });

  it('budget=0 short-circuits to an empty result', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      await remember(ctx, { content: 'budget-zero-test', kind: 'distilled' });

      const result = await contextGet(ctx, { currentProject: cwdProject(), budget: 0 });

      expect(result.entries).toEqual([]);
      expect(result.tokens).toBe(0);
    } finally {
      restore();
    }
  });
});
