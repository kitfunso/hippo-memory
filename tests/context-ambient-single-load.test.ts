// `hippo context` renders the ambient state getContext returns, so the printed summary counts the rows the context admitted.

import type { FullContext } from './_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';
import { getContext } from '../src/api/index.js';
import { computeAmbientState, renderAmbientSummary } from '../src/core/ambient.js';
import { _resetAblationCacheForTests } from '../src/core/ablation.js';
import { apiCtx } from './_helpers/api-ctx.js';
import { runCli } from '../src/cli.js';
import { withHookStdin } from './_helpers/hook-stdin.js';
import { runInProcess } from './_helpers/run-in-process.js';
import { makeRoot } from './_helpers/make-root.js';

const FAKE_NOW = '2026-09-06T12:00:00.000Z';

describe('`hippo context` prints the ambient summary getContext computed', () => {
  it('counts only the rows the context admitted (real CLI, real store)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-ambient-cli-'));
    for (const name of ['HIPPO_HOME', 'HOME', 'USERPROFILE']) vi.stubEnv(name, dir);
    const saved = process.cwd();
    process.chdir(dir);
    const hippo = (...args: string[]) => runInProcess(() => withHookStdin(undefined, () => runCli(['node', 'hippo', ...args])));
    try {
      expect((await hippo('init', '--no-hooks', '--no-schedule', '--no-learn')).status).toBe(0);
      expect((await hippo('remember', 'ambient single-load pin row')).status).toBe(0);
      // A row the context leaves out: a summary re-derived from every row would count two.
      writeEntry(path.join(dir, '.hippo'), createMemory('PRIVATE-SCOPE-ROW lives behind a private channel scope', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, scope: 'slack:private:C123' }));

      const result = await hippo('context');
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/^Memory state: 1 memories/m);
    } finally {
      process.chdir(saved);
      vi.unstubAllEnvs();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ambient summary: byte-identical, both v39 exclusion classes excluded', () => {
  let tmpRoot: string;
  let projA: string;
  let ctx: FullContext;

  beforeEach(() => {
    process.env.HIPPO_FAKE_NOW = FAKE_NOW;
    _resetAblationCacheForTests();
    tmpRoot = makeRoot('ambient-summary', { init: false });
    projA = path.join(tmpRoot, 'proj-a', '.hippo');
    fs.mkdirSync(projA, { recursive: true });
    initStore(projA);
    ctx = apiCtx(projA, 'default', { subject: 'cli', role: 'admin' });
  });

  afterEach(() => {
    delete process.env.HIPPO_FAKE_NOW;
    _resetAblationCacheForTests();
  });

  it('cross-project row + private-scope row are excluded from ambientState and its rendered summary', async () => {
    const admitted = { ...createMemory('ADMITTED-ROW stays visible in the landscape summary', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), origin_project: 'proj-a' };
    writeEntry(projA, admitted);

    const crossProjectRow = {
      ...createMemory('CROSS-PROJECT-ROW belongs to a different project entirely', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
      origin_project: 'proj-b',
    };
    writeEntry(projA, crossProjectRow);

    const privateScopeRow = {
      ...createMemory('PRIVATE-SCOPE-ROW lives behind a private channel scope', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, scope: 'slack:private:C123' }),
      origin_project: 'proj-a',
    };
    writeEntry(projA, privateScopeRow);

    const result = await getContext(ctx, { currentProject: 'proj-a', budget: 1500 });

    expect(result.ambientState).toBeDefined();
    expect(result.ambientState!.totalMemories).toBe(1);

    const expectedState = computeAmbientState([admitted]);
    expect(result.ambientState).toEqual(expectedState);
    expect(renderAmbientSummary(result.ambientState!)).toBe(renderAmbientSummary(expectedState));
  });
});

describe('ambient summary: avgStrength reflects post-retrieval strength, not the pre-mutation snapshot', () => {
  let tmpRoot: string;

  afterEach(() => {
    delete process.env.HIPPO_FAKE_NOW;
    _resetAblationCacheForTests();
  });

  it('avgStrength matches computeAmbientState over the returned (post-markRetrieved) entries, not the pre-retrieval ones', async () => {
    const AGED_NOW = '2026-01-01T00:00:00.000Z';
    process.env.HIPPO_FAKE_NOW = AGED_NOW;
    _resetAblationCacheForTests();

    tmpRoot = makeRoot('ambient-strength', { init: false });
    const projA = path.join(tmpRoot, 'proj-a', '.hippo');
    fs.mkdirSync(projA, { recursive: true });
    initStore(projA);
    const ctx: FullContext = apiCtx(projA, 'default', { subject: 'cli', role: 'admin' });

    // Half-life 7 days, aged ~8 months before the call below: pre-retrieval
    // strength decays to near zero.
    const aged = { ...createMemory('AGED-ROW decayed far past its half-life', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), origin_project: 'proj-a' };
    writeEntry(projA, aged);

    process.env.HIPPO_FAKE_NOW = FAKE_NOW;
    _resetAblationCacheForTests();

    const result = await getContext(ctx, { currentProject: 'proj-a', budget: 5000 });

    expect(result.entries.length).toBe(1);
    expect(result.ambientState).toBeDefined();

    // What the pre-fix code computed: the admitted entry BEFORE markRetrieved ran.
    const preRetrievalState = computeAmbientState([aged], new Date(FAKE_NOW));
    // What the post-fix code should compute: overlaid with the returned,
    // now-strengthened entry.
    const postRetrievalState = computeAmbientState(result.entries.map((e) => e.entry));

    expect(result.ambientState!.avgStrength).not.toBeCloseTo(preRetrievalState.avgStrength, 3);
    expect(result.ambientState!.avgStrength).toBeCloseTo(postRetrievalState.avgStrength, 10);
    expect(result.ambientState!.avgStrength).toBeGreaterThan(0.5);
  });
});
