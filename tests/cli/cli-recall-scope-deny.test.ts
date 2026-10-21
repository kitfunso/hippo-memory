/**
 * v1.25.0 (v39 post-ship tail #1) — direct CLI recall/explain scope default-deny.
 *
 * Before this release the direct CLI paths (printRecall / explainQuery) loaded
 * candidates via unscoped loadSearchEntries: `<source>:private:*` and
 * `unknown:legacy` rows reached output for no-scope callers, while
 * api.recall (HTTP/MCP) denied them. These tests lock the parity:
 *   - no --scope        → default-deny (private + quarantine excluded)
 *   - explicit --scope  → exact envelope-column match (deliberate access)
 *   - hasGlobal path    → searchBothHybrid recallScope plumb equally filtered
 *   - suppression stats → JS-half drops counted in droppedPreRank
 *   - hippo explain     → same rule + honest [note] when candidates hidden
 *
 * Runs the CLI entry in process against a real store; global-store rows are
 * seeded against the same SQLite.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { loadRecallSearchEntries } from '../../src/store/sqlite/folder-forms.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { withSharedStoreHandles } from '../../src/db/index.js';
import { handleExplain } from '../../src/surface/cli/explain.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { runCli } from '../../src/cli.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

const CLEAN = 'clean deploykey fact for everyone';
const PRIV_SLACK = 'private slack deploykey fact';
const PRIV_GITHUB = 'private github deploykey fact';
const LEGACY = 'legacy quarantined deploykey fact';

/** `hippo <args>` run in this process from `cwd`, the call bin/hippo.js makes; a non-zero exit fails the test. */
async function hippo(cwd: string, ...args: string[]): Promise<string> {
  const saved = process.cwd();
  process.chdir(cwd);
  try {
    const r = await runInProcess(() => runCli(['node', 'hippo', ...args]));
    expect(r.status, r.stderr).toBe(0);
    return r.stdout;
  } finally {
    process.chdir(saved);
  }
}

describe('cli recall scope default-deny', () => {
  let home: string;
  let globalDir: string;

  beforeEach(async () => {
    home = makeRoot('recall-scope', { init: false });
    globalDir = join(home, 'global-hippo');
    vi.stubEnv('HIPPO_HOME', globalDir);
    vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
    await hippo(home, 'init', '--no-hooks', '--no-schedule', '--no-learn');
    await hippo(home, 'remember', CLEAN);
    await hippo(home, 'remember', PRIV_SLACK, '--scope', 'slack:private:C1');
    await hippo(home, 'remember', PRIV_GITHUB, '--scope', 'github:private:owner/repo');
    await hippo(home, 'remember', LEGACY, '--scope', 'unknown:legacy');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('no-scope recall denies private and quarantine rows', async () => {
    const out = await hippo(home, 'recall', 'deploykey', '--limit', '10');
    expect(out).toContain(CLEAN);
    expect(out).not.toContain(PRIV_SLACK);
    expect(out).not.toContain(PRIV_GITHUB);
    expect(out).not.toContain(LEGACY);
  });

  it('explicit --scope UNLOCKS the named scope on top of the default set (additive CLI semantics)', async () => {
    const out = await hippo(home, 'recall', 'deploykey', '--scope', 'slack:private:C1', '--limit', '10');
    // Deliberate access to the requested private scope is preserved...
    expect(out).toContain(PRIV_SLACK);
    // ...the default-admitted set stays (the CLI flag is historically a
    // tag-boost hint; narrowing to the envelope column would empty every
    // tag-scoped recall — see tests/store/scope-boost.test.ts)...
    expect(out).toContain(CLEAN);
    // ...and OTHER private scopes + quarantine buckets stay denied.
    expect(out).not.toContain(PRIV_GITHUB);
    expect(out).not.toContain(LEGACY);
  });

  it('JSON output excludes denied rows pre-candidate (SQL predicate before the window)', async () => {
    const raw = await hippo(home, 'recall', 'deploykey', '--json', '--limit', '10');
    // SAFETY: `hippo recall --json` on this CLI always prints the recall-result
    // envelope with `results` and `suppressionSummary` fields, per src/cli.ts.
    const parsed = JSON.parse(raw) as {
      results: Array<{ content?: string; entry?: { content?: string } }>;
      suppressionSummary: { totalCandidates: number; droppedPreRank: number };
    };
    const text = JSON.stringify(parsed.results);
    expect(text).not.toContain(PRIV_SLACK);
    expect(text).not.toContain(PRIV_GITHUB);
    expect(text).not.toContain(LEGACY);
    // v1.12.13 accounting convention: SQL-excluded rows (quarantine + the
    // v1.25.0 pre-window ':private:' exclusion) are pre-candidate — they
    // never appear in totalCandidates and are not counted as drops. Of the
    // four seeded rows matching 'deploykey', only CLEAN is a candidate.
    expect(parsed.suppressionSummary.totalCandidates).toBe(1);
    expect(parsed.suppressionSummary.droppedPreRank).toBe(0);
  });

  it('hasGlobal path (searchBothHybrid recallScope) filters global-store rows equally', async () => {
    initTestStore(globalDir);
    writeEntry(globalDir, createMemory('global clean deploykey note', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
    writeEntry(
      globalDir,
      createMemory('global private deploykey note', {
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
        scope: 'slack:private:CG',
      }),
    );

    const out = await hippo(home, 'recall', 'deploykey', '--limit', '10');
    expect(out).toContain('global clean deploykey note');
    expect(out).not.toContain('global private deploykey note');
    expect(out).not.toContain(PRIV_SLACK);
  });

  it('hasGlobal path: explicit --scope additively unlocks the requested private scope on the GLOBAL store too', async () => {
    // independent-review-critic round 1 med: the additive unlock was only
    // covered on the local-only path.
    initTestStore(globalDir);
    writeEntry(globalDir, createMemory('global clean deploykey note', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
    writeEntry(
      globalDir,
      createMemory('global private deploykey note', {
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
        scope: 'slack:private:CG',
      }),
    );

    const out = await hippo(home, 'recall', 'deploykey', '--scope', 'slack:private:CG', '--limit', '10');
    expect(out).toContain('global private deploykey note');
    expect(out).toContain('global clean deploykey note');
    // Non-requested private scopes stay denied on both stores.
    expect(out).not.toContain(PRIV_SLACK);
    expect(out).not.toContain(PRIV_GITHUB);
  });

  it('private rows cannot starve admitted rows out of the SQL candidate window', async () => {
    // 220 matching private rows > the 200-row default window. Pre-fix, the
    // window filled with private rows in SQL and the JS filter then emptied
    // it, so the one admitted row never surfaced. The SQL pre-window
    // NOT LIKE '%:private:%' exclusion keeps the window for admitted rows.
    const hippoDir = join(home, '.hippo');
    // One connection for all 221 writes: a close per write checkpoints the WAL, which timed this out on Windows CI.
    await withSharedStoreHandles(() => {
      for (let i = 0; i < 220; i++) {
        writeEntry(
          hippoDir,
          createMemory(`windowstarve private filler row number ${i}`, {
            baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
            scope: 'slack:private:Cbulk',
          }),
        );
      }
      writeEntry(
        hippoDir,
        createMemory('windowstarve admitted public row', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
      );
    });

    const entries = loadRecallSearchEntries(hippoDir, 'windowstarve', { tenantId: 'default' });
    const contents = entries.map((e) => e.content);
    expect(contents).toContain('windowstarve admitted public row');
    expect(contents.some((c) => c.includes('private filler'))).toBe(false);

    // End-to-end through the CLI for belt and braces.
    const out = await hippo(home, 'recall', 'windowstarve', '--limit', '10');
    expect(out).toContain('windowstarve admitted public row');
    expect(out).not.toContain('private filler');
  });

  it('hippo explain applies the same rule and prints an honest note', async () => {
    const res = await runInProcess(() =>
      handleExplain({ hippoRoot: join(home, '.hippo'), tenantId: 'default', args: ['deploykey'], flags: {} }),
    );
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain(PRIV_SLACK);
    expect(res.stdout).not.toContain(PRIV_GITHUB);
    expect(res.stdout).not.toContain(LEGACY);
    expect(res.stderr).toMatch(/hidden by recall scope policy/);
  });
});
