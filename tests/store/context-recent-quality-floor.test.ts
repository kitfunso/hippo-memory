import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach, vi, onTestFinished } from 'vitest';
import * as path from 'node:path';
import { rmSync } from 'node:fs';
import { createMemory } from '../../src/entry/memory.js';
import { Layer } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { contextGet } from '../../src/api/index.js';
import { runCli } from '../../src/cli.js';
import { withHookStdin } from '../_helpers/hook-stdin.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { cwdProject } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { initTestStore } from '../_helpers/store-template.js';
import { removeDir } from '../_helpers/remove-dir.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

afterEach(() => {
  vi.unstubAllEnvs();
});
const { writeEntry, apiCtx } = sessionPerTest();

function tmpHome() {
  const home = makeRoot('df3');
  const globalTmp = makeRoot('df3-global', { init: false });
  vi.stubEnv('HIPPO_HOME', globalTmp);
  return {
    home,
    restore: () =>
      onTestFinished(() => {
        removeDir(home);
        rmSync(globalTmp, { recursive: true, force: true });
      }),
  };
}

function seed(home: string, content: string, opts: { pinned?: boolean; created?: string } = {}) {
  const entry = createMemory(content, {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    pinned: opts.pinned ?? false,
    layer: Layer.Episodic,
    tenantId: 'default',
  });
  if (opts.created) entry.created = opts.created;
  writeEntry(home, entry);
  return entry;
}

describe('includeRecent quality floor (api.contextGet)', () => {
  it('red-under-old: one junk + four clean recent writes inject only the clean four', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });

      seed(home, 'fixed signals', { created: '2026-08-20T10:00:05.000Z' });
      seed(home, 'clean memory number one with plenty of specific detail worth keeping', {
        created: '2026-08-20T10:00:04.000Z',
      });
      seed(home, 'clean memory number two with plenty of specific detail worth keeping', {
        created: '2026-08-20T10:00:03.000Z',
      });
      seed(home, 'clean memory number three with plenty of specific detail worth keeping', {
        created: '2026-08-20T10:00:02.000Z',
      });
      seed(home, 'clean memory number four with plenty of specific detail worth keeping', {
        created: '2026-08-20T10:00:01.000Z',
      });

      const result = await contextGet(ctx, {
        currentProject: cwdProject(),
        pinnedOnly: true,
        includeRecent: 5,
        budget: 2000,
      });
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

  it('filter-before-slice: backfills past junk to exactly N clean entries, not N-minus-junk', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });

      seed(home, 'quick patch applied', { created: '2026-08-20T10:00:08.000Z' });
      seed(home, 'clean memory alpha with plenty of specific detail worth keeping', {
        created: '2026-08-20T10:00:07.000Z',
      });
      seed(home, 'tweaked config again', { created: '2026-08-20T10:00:06.000Z' });
      seed(home, 'clean memory bravo with plenty of specific detail worth keeping', {
        created: '2026-08-20T10:00:05.000Z',
      });
      seed(home, 'globe view on by default', { created: '2026-08-20T10:00:04.000Z' });
      seed(home, 'clean memory charlie with plenty of specific detail worth keeping', {
        created: '2026-08-20T10:00:03.000Z',
      });
      seed(home, 'clean memory delta with plenty of specific detail worth keeping', {
        created: '2026-08-20T10:00:02.000Z',
      });
      seed(home, 'clean memory echo with plenty of specific detail worth keeping', {
        created: '2026-08-20T10:00:01.000Z',
      });

      const result = await contextGet(ctx, {
        currentProject: cwdProject(),
        pinnedOnly: true,
        includeRecent: 5,
        budget: 3000,
      });
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

  it('pinned unaffected: a pinned entry that fails the heuristic still injects', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });

      seed(home, 'fixed signals', { pinned: true, created: '2026-08-20T10:00:00.000Z' });

      const result = await contextGet(ctx, {
        currentProject: cwdProject(),
        pinnedOnly: true,
        includeRecent: 0,
        budget: 500,
      });
      const contents = result.entries.map((e) => e.entry.content);

      expect(contents).toContain('fixed signals');
    } finally {
      restore();
    }
  });

  it('pinned displacement under budget pressure, a pinned entry occupying a recent slot must still inject once budget is tight', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });

      seed(home, 'fixed signals', { pinned: true, created: '2026-08-20T10:00:03.000Z' });
      seed(home, 'clean recent entry alpha with plenty of specific detail worth keeping', {
        created: '2026-08-20T10:00:02.000Z',
      });
      seed(home, 'clean recent entry bravo with plenty of specific detail worth keeping', {
        created: '2026-08-20T10:00:01.000Z',
      });
      seed(home, 'clean recent entry charlie with plenty of specific detail worth keeping', {
        created: '2026-08-20T10:00:00.000Z',
      });

      const result = await contextGet(ctx, {
        currentProject: cwdProject(),
        pinnedOnly: true,
        includeRecent: 3,
        budget: 55,
      });
      const contents = result.entries.map((e) => e.entry.content);

      expect(contents).toContain('fixed signals');
    } finally {
      restore();
    }
  });

  it('measured-limitation pin: a real mid-sentence fragment is NOT filtered', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });

      const fragment = 'fetches a quote → blank price';
      seed(home, fragment, { created: '2026-08-20T10:00:00.000Z' });

      const result = await contextGet(ctx, {
        currentProject: cwdProject(),
        pinnedOnly: true,
        includeRecent: 1,
        budget: 500,
      });
      const contents = result.entries.map((e) => e.entry.content);

      expect(contents).toContain(fragment);
    } finally {
      restore();
    }
  });

  it('includeRecent 0/absent: byte-identical behavior to today (junk never considered)', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });

      seed(home, 'pinned rule that always injects regardless of recent settings', {
        pinned: true,
        created: '2026-08-20T10:00:01.000Z',
      });
      seed(home, 'fixed signals', { created: '2026-08-20T10:00:00.000Z' });

      const resultAbsent = await contextGet(ctx, { currentProject: cwdProject(), pinnedOnly: true, budget: 500 });
      const resultExplicitZero = await contextGet(ctx, {
        currentProject: cwdProject(),
        pinnedOnly: true,
        includeRecent: 0,
        budget: 500,
      });

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

  it('repro: shared-budget reserve keeps a pin outside the recent-N window from being displaced by DF3 backfill', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });

      seed(home, 'tmp', { created: '2026-08-20T10:00:04.000Z' });
      seed(home, 'clean recent entry alpha with plenty of specific detail worth keeping', {
        created: '2026-08-20T10:00:03.000Z',
      });
      seed(home, 'clean recent entry bravo with plenty of specific detail worth keeping', {
        created: '2026-08-20T10:00:02.000Z',
      });
      seed(home, 'clean recent entry charlx with plenty of specific detail worth keeping', {
        created: '2026-08-20T10:00:01.000Z',
      });
      seed(home, 'fixed signals', { pinned: true, created: '2026-08-20T10:00:00.000Z' });

      const result = await contextGet(ctx, {
        currentProject: cwdProject(),
        pinnedOnly: true,
        includeRecent: 3,
        budget: 55,
      });
      const contents = result.entries.map((e) => e.entry.content);

      expect(contents).toContain('fixed signals');
    } finally {
      restore();
    }
  });

  it('pins win under heavy budget pressure: budget only fits the pin, all recents are dropped', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });

      seed(home, 'fixed signals', { pinned: true, created: '2026-08-20T10:00:01.000Z' });
      seed(home, 'clean recent entry alpha with plenty of specific detail worth keeping', {
        created: '2026-08-20T10:00:00.000Z',
      });

      const result = await contextGet(ctx, {
        currentProject: cwdProject(),
        pinnedOnly: true,
        includeRecent: 3,
        budget: 5,
      });
      const contents = result.entries.map((e) => e.entry.content);

      expect(contents).toEqual(['fixed signals']);
    } finally {
      restore();
    }
  });

  it('no under-fill regression: generous budget returns the same entries as before the reserve', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });

      seed(home, 'clean recent entry alpha with plenty of specific detail worth keeping', {
        created: '2026-08-20T10:00:02.000Z',
      });
      seed(home, 'clean recent entry bravo with plenty of specific detail worth keeping', {
        created: '2026-08-20T10:00:01.000Z',
      });
      seed(home, 'clean recent entry charlx with plenty of specific detail worth keeping', {
        created: '2026-08-20T10:00:00.000Z',
      });
      seed(home, 'fixed signals', { pinned: true, created: '2026-08-19T10:00:00.000Z' });

      const result = await contextGet(ctx, {
        currentProject: cwdProject(),
        pinnedOnly: true,
        includeRecent: 3,
        budget: 2000,
      });
      const contents = result.entries.map((e) => e.entry.content);

      expect(contents).toContain('fixed signals');
      expect(contents).toContain('clean recent entry alpha with plenty of specific detail worth keeping');
      expect(contents).toContain('clean recent entry bravo with plenty of specific detail worth keeping');
      expect(contents).toContain('clean recent entry charlx with plenty of specific detail worth keeping');
      expect(contents.length).toBe(4);
    } finally {
      restore();
    }
  });

  it('all-recent-junk: recent contributes nothing, no crash, pinned entries still returned', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });

      seed(home, 'surviving pinned rule that must still appear even with all recent junk', {
        pinned: true,
        created: '2026-08-20T10:00:03.000Z',
      });
      seed(home, 'fixed signals', { created: '2026-08-20T10:00:02.000Z' });
      seed(home, 'globe view on by default', { created: '2026-08-20T10:00:01.000Z' });
      seed(home, 'quick patch applied', { created: '2026-08-20T10:00:00.000Z' });

      const result = await contextGet(ctx, {
        currentProject: cwdProject(),
        pinnedOnly: true,
        includeRecent: 5,
        budget: 500,
      });
      const contents = result.entries.map((e) => e.entry.content);

      expect(contents).toEqual(['surviving pinned rule that must still appear even with all recent junk']);
    } finally {
      restore();
    }
  });
});

describe('includeRecent quality floor (CLI end-to-end)', () => {
  let tmpDir: string;
  let hippoDir: string;

  beforeEach(() => {
    tmpDir = makeRoot('df3-cli', { init: false });
    hippoDir = path.join(tmpDir, '.hippo');
  });

  async function runHippo(args: string[]): Promise<string> {
    vi.stubEnv('HIPPO_HOME', path.join(tmpDir, 'global'));
    const saved = process.cwd();
    process.chdir(tmpDir);
    try {
      const r = await runInProcess(() => withHookStdin(undefined, () => runCli(['node', 'hippo', ...args])));
      expect(r.status, r.stderr).toBe(0);
      return r.stdout;
    } finally {
      process.chdir(saved);
    }
  }

  it('`hippo context --pinned-only --include-recent 5` excludes junk against a seeded store', async () => {
    initTestStore(hippoDir);
    const junk = createMemory('fixed signals', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, layer: Layer.Episodic });
    const clean = createMemory('clean CLI-seeded memory with plenty of specific detail worth keeping', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Episodic,
    });
    junk.created = '2026-08-20T10:00:01.000Z';
    clean.created = '2026-08-20T10:00:00.000Z';
    writeEntry(hippoDir, junk);
    writeEntry(hippoDir, clean);

    const out = await runHippo([
      'context',
      '--pinned-only',
      '--include-recent',
      '5',
      '--format',
      'additional-context',
      '--budget',
      '500',
    ]);
    const parsed = JSON.parse(out);
    const context = parsed.hookSpecificOutput.additionalContext;

    expect(context).toContain('clean CLI-seeded memory with plenty of specific detail worth keeping');
    expect(context).not.toContain('fixed signals');
  });
});

describe('pinned budget reserve dedupes mirrored entries', () => {
  let home: string;
  let globalTmp: string;

  beforeEach(() => {
    home = makeRoot('df3-dedupe');
    globalTmp = makeRoot('df3-dedupe-global');
    vi.stubEnv('HIPPO_HOME', globalTmp);
  });

  it('a pin mirrored in local+global reserves its cost ONCE, so a recent entry still fits', async () => {
    const pin = createMemory('pinned rule that is mirrored across both stores', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      pinned: true,
      layer: Layer.Episodic,
      tenantId: 'default',
    });
    pin.created = new Date(Date.now() - 60_000).toISOString();
    writeEntry(home, pin);
    writeEntry(globalTmp, pin);

    const recent = createMemory('a clean recent memory that should still fit alongside the single pin', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      pinned: false,
      layer: Layer.Episodic,
      tenantId: 'default',
    });
    writeEntry(home, recent);

    const ctx: FullContext = apiCtx(home, 'default', { subject: 'test', role: 'admin' });
    const res = await contextGet(ctx, { currentProject: cwdProject(), pinnedOnly: true, includeRecent: 3, budget: 35 });
    const contents = res.entries.map((e) => e.entry.content);

    expect(contents).toContain(pin.content);
    expect(contents.filter((c) => c === pin.content)).toHaveLength(1);
    expect(contents).toContain(recent.content);
  });
});
