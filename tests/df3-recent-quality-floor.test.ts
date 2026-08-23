/**
 * DF3 — quality floor on `--include-recent` injection
 * (docs/plans/2026-08-23-df3-include-recent-quality-floor.md).
 *
 * Covers the plan's 7-test list against the `includeRecent` block inside
 * `api.getContext`'s `pinnedOnly` branch (src/api.ts:2456-2491), which now
 * filters candidates with `isContentWorthStoring` (src/audit.ts:117) before
 * slicing to `includeRecent`.
 *
 * Real-DB per project convention. Tests 1-6 seed entries directly via
 * `createMemory` + `writeEntry` (so `pinned` and `created` can be set) and
 * assert on `api.getContext`, following the `tmpHome` isolation pattern from
 * tests/api-context.test.ts. Test 7 goes through the built CLI, following
 * tests/pinned-inject.test.ts's `runHippo` pattern.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { getContext, type Context } from '../src/api.js';

function tmpHome() {
  const home = mkdtempSync(join(tmpdir(), 'hippo-df3-'));
  initStore(home);
  // Per-test HIPPO_HOME override pointing to a separate UNINITIALIZED dir so
  // hasGlobal=false inside api.getContext (same pattern as api-context.test.ts).
  const globalTmp = mkdtempSync(join(tmpdir(), 'hippo-df3-global-'));
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

function seed(
  home: string,
  content: string,
  opts: { pinned?: boolean; created?: string } = {},
) {
  const entry = createMemory(content, {
    pinned: opts.pinned ?? false,
    layer: Layer.Episodic,
    tenantId: 'default',
  });
  if (opts.created) entry.created = opts.created;
  writeEntry(home, entry);
  return entry;
}

describe('DF3 — includeRecent quality floor (api.getContext)', () => {
  it('test 1 — red-under-old: one junk + four clean recent writes inject only the clean four', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: Context = { hippoRoot: home, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };

      // Real junk text per DF4's flagged auto-learn class (roadmap acceptance,
      // verbatim). Newest of the five, so a naive post-slice would still admit it.
      seed(home, 'fixed signals', { created: '2026-08-20T10:00:05.000Z' });
      seed(home, 'clean memory number one with plenty of specific detail worth keeping', { created: '2026-08-20T10:00:04.000Z' });
      seed(home, 'clean memory number two with plenty of specific detail worth keeping', { created: '2026-08-20T10:00:03.000Z' });
      seed(home, 'clean memory number three with plenty of specific detail worth keeping', { created: '2026-08-20T10:00:02.000Z' });
      seed(home, 'clean memory number four with plenty of specific detail worth keeping', { created: '2026-08-20T10:00:01.000Z' });

      const result = await getContext(ctx, { pinnedOnly: true, includeRecent: 5, budget: 2000 });
      const contents = result.entries.map((e) => e.entry.content);

      expect(contents).toContain('clean memory number one with plenty of specific detail worth keeping');
      expect(contents).toContain('clean memory number two with plenty of specific detail worth keeping');
      expect(contents).toContain('clean memory number three with plenty of specific detail worth keeping');
      expect(contents).toContain('clean memory number four with plenty of specific detail worth keeping');
      expect(contents).not.toContain('fixed signals');
      expect(contents.length).toBe(4);
    } finally {
      restore();
    }
  });

  it('test 2 — filter-before-slice: backfills past junk to exactly N clean entries, not N-minus-junk', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: Context = { hippoRoot: home, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };

      // 8 recent entries, clean/junk interleaved (3 junk, 5 clean — not a
      // strict 1:1 alternation, because a strict 4/4 split over 8 entries
      // cannot ever produce "exactly 5 clean" no matter how backfill works;
      // 5 clean is the minimum needed to prove the N=5 backfill claim).
      // Newest-to-oldest: junk, clean, junk, clean, junk, clean, clean, clean.
      // A naive post-slice-then-filter (top 5 by recency, then drop junk)
      // would only surface 2 clean entries (ranks 2 and 4). The pre-slice
      // filter must surface all 5.
      seed(home, 'quick patch applied', { created: '2026-08-20T10:00:08.000Z' });
      seed(home, 'clean memory alpha with plenty of specific detail worth keeping', { created: '2026-08-20T10:00:07.000Z' });
      seed(home, 'tweaked config again', { created: '2026-08-20T10:00:06.000Z' });
      seed(home, 'clean memory bravo with plenty of specific detail worth keeping', { created: '2026-08-20T10:00:05.000Z' });
      seed(home, 'globe view on by default', { created: '2026-08-20T10:00:04.000Z' });
      seed(home, 'clean memory charlie with plenty of specific detail worth keeping', { created: '2026-08-20T10:00:03.000Z' });
      seed(home, 'clean memory delta with plenty of specific detail worth keeping', { created: '2026-08-20T10:00:02.000Z' });
      seed(home, 'clean memory echo with plenty of specific detail worth keeping', { created: '2026-08-20T10:00:01.000Z' });

      const result = await getContext(ctx, { pinnedOnly: true, includeRecent: 5, budget: 3000 });
      const contents = result.entries.map((e) => e.entry.content);

      expect(contents).toContain('clean memory alpha with plenty of specific detail worth keeping');
      expect(contents).toContain('clean memory bravo with plenty of specific detail worth keeping');
      expect(contents).toContain('clean memory charlie with plenty of specific detail worth keeping');
      expect(contents).toContain('clean memory delta with plenty of specific detail worth keeping');
      expect(contents).toContain('clean memory echo with plenty of specific detail worth keeping');
      expect(contents).not.toContain('quick patch applied');
      expect(contents).not.toContain('tweaked config again');
      expect(contents).not.toContain('globe view on by default');
      expect(contents.length).toBe(5);
    } finally {
      restore();
    }
  });

  it('test 3 — pinned unaffected: a pinned entry that fails the heuristic still injects', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: Context = { hippoRoot: home, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };

      // Pinned entry with content that would fail isContentWorthStoring
      // (same junk text as test 1) — explicit user intent (pin) wins because
      // the pinned block (api.ts:2493-2524) is a separate loop that admits
      // every pinned entry unconditionally, untouched by this plan.
      seed(home, 'fixed signals', { pinned: true, created: '2026-08-20T10:00:00.000Z' });

      const result = await getContext(ctx, { pinnedOnly: true, includeRecent: 0, budget: 500 });
      const contents = result.entries.map((e) => e.entry.content);

      expect(contents).toContain('fixed signals');
    } finally {
      restore();
    }
  });

  it('test 3b — pinned displacement under budget pressure (codex finding): a pinned entry occupying a recent slot must still inject once budget is tight', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: Context = { hippoRoot: home, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };

      // The pinned entry fails isContentWorthStoring and is the NEWEST entry,
      // so it occupies a slot in the recent-N window (includeRecent: 3).
      // Without the `entry.pinned ||` bypass in the recent filter, this
      // entry is dropped from the candidate list BEFORE the slice, so the
      // three clean unpinned entries below backfill into the window and
      // consume the entire budget in the recent loop. By the time the
      // dedicated pinned block runs, there is no budget left and the pinned
      // entry is skipped via `continue` — displacing explicit user intent.
      // Token costs (estimateTokens, chars/4 rounded up): "fixed signals" = 4,
      // each clean entry below = 18. budget: 55.
      //   OLD (bug): recent slice = [alpha, bravo, charlie] (pinned dropped
      //     pre-slice) -> 18+18+18 = 54 <= 55, all three fit, usedP = 54.
      //     Pinned block then needs 54+4=58 > 55 -> SKIPPED.
      //   NEW (fix): recent slice = [pinned, alpha, bravo] (pinned survives
      //     the filter and is newest) -> 4+18+18 = 40 <= 55, all three fit
      //     including the pinned entry directly in the recent loop.
      seed(home, 'fixed signals', { pinned: true, created: '2026-08-20T10:00:03.000Z' });
      seed(home, 'clean recent entry alpha with plenty of specific detail worth keeping', { created: '2026-08-20T10:00:02.000Z' });
      seed(home, 'clean recent entry bravo with plenty of specific detail worth keeping', { created: '2026-08-20T10:00:01.000Z' });
      seed(home, 'clean recent entry charlie with plenty of specific detail worth keeping', { created: '2026-08-20T10:00:00.000Z' });

      const result = await getContext(ctx, { pinnedOnly: true, includeRecent: 3, budget: 55 });
      const contents = result.entries.map((e) => e.entry.content);

      expect(contents).toContain('fixed signals');
    } finally {
      restore();
    }
  });

  it('test 4 — measured-limitation pin: a real mid-sentence fragment is NOT filtered', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: Context = { hippoRoot: home, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };

      // Real live fragment text from the plan's measured-scope table. DF3
      // fixes the vague/no-specificity/version-bump/too-short class; it
      // cannot catch mid-sentence fragments, which are indistinguishable
      // from good content at this read surface (DF2's producer job).
      // This is a deliberate documentation pin, not a bug being reproduced.
      const fragment = 'fetches a quote → blank price';
      seed(home, fragment, { created: '2026-08-20T10:00:00.000Z' });

      const result = await getContext(ctx, { pinnedOnly: true, includeRecent: 1, budget: 500 });
      const contents = result.entries.map((e) => e.entry.content);

      expect(contents).toContain(fragment);
    } finally {
      restore();
    }
  });

  it('test 5 — includeRecent 0/absent: byte-identical behavior to today (junk never considered)', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: Context = { hippoRoot: home, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };

      // A pinned clean entry plus a recent junk entry. With includeRecent
      // unset/0 the whole recent block (and therefore the new filter) is
      // never entered — the junk is absent because the block never runs,
      // not because the filter caught it. Compares the absent-vs-explicit-0
      // shapes to lock the pre-existing default.
      seed(home, 'pinned rule that always injects regardless of recent settings', { pinned: true, created: '2026-08-20T10:00:01.000Z' });
      seed(home, 'fixed signals', { created: '2026-08-20T10:00:00.000Z' });

      const resultAbsent = await getContext(ctx, { pinnedOnly: true, budget: 500 });
      const resultExplicitZero = await getContext(ctx, { pinnedOnly: true, includeRecent: 0, budget: 500 });

      for (const result of [resultAbsent, resultExplicitZero]) {
        const contents = result.entries.map((e) => e.entry.content);
        expect(contents).toContain('pinned rule that always injects regardless of recent settings');
        expect(contents).not.toContain('fixed signals');
        expect(contents.length).toBe(1);
      }
    } finally {
      restore();
    }
  });

  it('test 6 — all-recent-junk: recent contributes nothing, no crash, pinned entries still returned', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: Context = { hippoRoot: home, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };

      seed(home, 'surviving pinned rule that must still appear even with all recent junk', { pinned: true, created: '2026-08-20T10:00:03.000Z' });
      seed(home, 'fixed signals', { created: '2026-08-20T10:00:02.000Z' });
      seed(home, 'globe view on by default', { created: '2026-08-20T10:00:01.000Z' });
      seed(home, 'quick patch applied', { created: '2026-08-20T10:00:00.000Z' });

      const result = await getContext(ctx, { pinnedOnly: true, includeRecent: 5, budget: 500 });
      const contents = result.entries.map((e) => e.entry.content);

      expect(contents).toEqual(['surviving pinned rule that must still appear even with all recent junk']);
    } finally {
      restore();
    }
  });
});

describe('DF3 — includeRecent quality floor (CLI end-to-end)', () => {
  let tmpDir: string;
  let hippoDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-df3-cli-'));
    hippoDir = path.join(tmpDir, '.hippo');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const HIPPO_JS = path.resolve(__dirname, '..', 'bin', 'hippo.js');

  function runHippo(args: string[]): string {
    const globalDir = path.join(tmpDir, 'global');
    return execFileSync(process.execPath, [HIPPO_JS, ...args], {
      env: { ...process.env, HIPPO_HOME: globalDir },
      cwd: tmpDir,
      encoding: 'utf8',
    });
  }

  it('test 7 — `hippo context --pinned-only --include-recent 5` excludes junk against a seeded store', () => {
    initStore(hippoDir);
    const junk = createMemory('fixed signals', { layer: Layer.Episodic });
    const clean = createMemory('clean CLI-seeded memory with plenty of specific detail worth keeping', { layer: Layer.Episodic });
    junk.created = '2026-08-20T10:00:01.000Z';
    clean.created = '2026-08-20T10:00:00.000Z';
    writeEntry(hippoDir, junk);
    writeEntry(hippoDir, clean);

    const out = runHippo(['context', '--pinned-only', '--include-recent', '5', '--format', 'additional-context', '--budget', '500']);
    const parsed = JSON.parse(out);
    const context = parsed.hookSpecificOutput.additionalContext;

    expect(context).toContain('clean CLI-seeded memory with plenty of specific detail worth keeping');
    expect(context).not.toContain('fixed signals');
  });
});
