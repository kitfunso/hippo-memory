// `hippo context` renders the ambient state getContext returns, so the printed summary counts the rows the context admitted.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';
import { getContext, type Context } from '../src/api/index.js';
import { computeAmbientState, renderAmbientSummary } from '../src/core/ambient.js';
import { _resetAblationCacheForTests } from '../src/core/ablation.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HIPPO_JS = path.join(repoRoot, 'bin', 'hippo.js');
const FAKE_NOW = '2026-09-06T12:00:00.000Z';

describe('`hippo context` prints the ambient summary getContext computed', () => {
  it('counts only the rows the context admitted (real CLI, real store)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-ambient-cli-'));
    const env = { ...process.env, HIPPO_HOME: dir, HOME: dir, USERPROFILE: dir };
    try {
      const init = spawnSync(process.execPath, [HIPPO_JS, 'init', '--no-hooks', '--no-schedule', '--no-learn'], {
        cwd: dir, env, encoding: 'utf8',
      });
      expect(init.status).toBe(0);

      const remembered = spawnSync(process.execPath, [HIPPO_JS, 'remember', 'ambient single-load pin row'], {
        cwd: dir, env, encoding: 'utf8',
      });
      expect(remembered.status).toBe(0);
      // A row the context leaves out: a summary re-derived from every row would count two.
      writeEntry(path.join(dir, '.hippo'), createMemory('PRIVATE-SCOPE-ROW lives behind a private channel scope', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, scope: 'slack:private:C123' }));

      const result = spawnSync(process.execPath, [HIPPO_JS, 'context'], { cwd: dir, env, encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/^Memory state: 1 memories/m);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ambient summary: byte-identical, both v39 exclusion classes excluded', () => {
  let tmpRoot: string;
  let projA: string;
  let ctx: Context;

  beforeEach(() => {
    process.env.HIPPO_FAKE_NOW = FAKE_NOW;
    _resetAblationCacheForTests();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-ambient-summary-'));
    projA = path.join(tmpRoot, 'proj-a', '.hippo');
    fs.mkdirSync(projA, { recursive: true });
    initStore(projA);
    ctx = { hippoRoot: projA, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };
  });

  afterEach(() => {
    delete process.env.HIPPO_FAKE_NOW;
    _resetAblationCacheForTests();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
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
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('avgStrength matches computeAmbientState over the returned (post-markRetrieved) entries, not the pre-retrieval ones', async () => {
    const AGED_NOW = '2026-01-01T00:00:00.000Z';
    process.env.HIPPO_FAKE_NOW = AGED_NOW;
    _resetAblationCacheForTests();

    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-ambient-strength-'));
    const projA = path.join(tmpRoot, 'proj-a', '.hippo');
    fs.mkdirSync(projA, { recursive: true });
    initStore(projA);
    const ctx: Context = { hippoRoot: projA, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };

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

describe('`hippo context --json` is unchanged', () => {
  it('the JSON shape carries no ambient field, even with ambient enabled and entries admitted', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-ambient-json-'));
    const env = { ...process.env, HIPPO_HOME: dir, HOME: dir, USERPROFILE: dir };
    try {
      const init = spawnSync(process.execPath, [HIPPO_JS, 'init', '--no-hooks', '--no-schedule', '--no-learn'], {
        cwd: dir, env, encoding: 'utf8',
      });
      expect(init.status).toBe(0);

      const remembered = spawnSync(process.execPath, [HIPPO_JS, 'remember', 'json-shape pin row'], {
        cwd: dir, env, encoding: 'utf8',
      });
      expect(remembered.status).toBe(0);

      const result = spawnSync(process.execPath, [HIPPO_JS, 'context', '--format', 'json'], {
        cwd: dir, env, encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      // SAFETY: `hippo context --format json` prints the cli.ts literal at
      // cli.ts:6018-6037 (query/activeSnapshot/sessionHandoff/recentSessionEvents/memories/tokens).
      const parsed = JSON.parse(result.stdout) as { ambientState?: unknown };
      expect(Object.keys(parsed).sort()).toEqual(
        ['activeSnapshot', 'memories', 'query', 'recentSessionEvents', 'sessionHandoff', 'tokens'].sort(),
      );
      expect(parsed.ambientState).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
