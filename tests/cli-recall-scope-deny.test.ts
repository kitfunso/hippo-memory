/**
 * v1.25.0 (v39 post-ship tail #1) — direct CLI recall/explain scope default-deny.
 *
 * Before this release the direct CLI paths (cmdRecall / cmdExplain) loaded
 * candidates via unscoped loadSearchEntries: `<source>:private:*` and
 * `unknown:legacy` rows reached output for no-scope callers, while
 * api.recall (HTTP/MCP) denied them. These tests lock the parity:
 *   - no --scope        → default-deny (private + quarantine excluded)
 *   - explicit --scope  → exact envelope-column match (deliberate access)
 *   - hasGlobal path    → searchBothHybrid recallScope plumb equally filtered
 *   - suppression stats → JS-half drops counted in droppedPreRank
 *   - hippo explain     → same rule + honest [note] when candidates hidden
 *
 * Subprocess pattern per tests/cli-recall-filters.test.ts (real store, real
 * bin). Global-store rows are seeded in-process against the same SQLite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry, loadRecallSearchEntries } from '../src/store.js';
import { createMemory } from '../src/memory.js';

const HIPPO_BIN = join(process.cwd(), 'bin', 'hippo.js');

const CLEAN = 'clean deploykey fact for everyone';
const PRIV_SLACK = 'private slack deploykey fact';
const PRIV_GITHUB = 'private github deploykey fact';
const LEGACY = 'legacy quarantined deploykey fact';

function hippo(cwd: string, env: Record<string, string>, ...args: string[]): string {
  return execFileSync('node', [HIPPO_BIN, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
  });
}

describe('cli recall scope default-deny (v1.25.0)', () => {
  let home: string;
  let env: Record<string, string>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hippo-recall-scope-'));
    env = {
      HIPPO_HOME: join(home, 'global-hippo'),
      HIPPO_SKIP_AUTO_INTEGRATIONS: '1',
    };
    hippo(home, env, 'init', '--no-hooks', '--no-schedule', '--no-learn');
    hippo(home, env, 'remember', CLEAN);
    hippo(home, env, 'remember', PRIV_SLACK, '--scope', 'slack:private:C1');
    hippo(home, env, 'remember', PRIV_GITHUB, '--scope', 'github:private:owner/repo');
    hippo(home, env, 'remember', LEGACY, '--scope', 'unknown:legacy');
  });

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('no-scope recall denies private and quarantine rows', () => {
    const out = hippo(home, env, 'recall', 'deploykey', '--limit', '10');
    expect(out).toContain(CLEAN);
    expect(out).not.toContain(PRIV_SLACK);
    expect(out).not.toContain(PRIV_GITHUB);
    expect(out).not.toContain(LEGACY);
  });

  it('explicit --scope UNLOCKS the named scope on top of the default set (additive CLI semantics)', () => {
    const out = hippo(home, env, 'recall', 'deploykey', '--scope', 'slack:private:C1', '--limit', '10');
    // Deliberate access to the requested private scope is preserved...
    expect(out).toContain(PRIV_SLACK);
    // ...the default-admitted set stays (the CLI flag is historically a
    // tag-boost hint; narrowing to the envelope column would empty every
    // tag-scoped recall — see tests/scope-boost.test.ts)...
    expect(out).toContain(CLEAN);
    // ...and OTHER private scopes + quarantine buckets stay denied.
    expect(out).not.toContain(PRIV_GITHUB);
    expect(out).not.toContain(LEGACY);
  });

  it.each(['recall', 'explain'])('%s rejects a value-less --scope', (command) => {
    const res = spawnSync('node', [HIPPO_BIN, command, 'deploykey', '--scope'], {
      cwd: home,
      env: { ...process.env, ...env },
      encoding: 'utf-8',
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--scope requires a value');
  });

  it('JSON output excludes denied rows pre-candidate (SQL predicate before the window)', () => {
    const raw = hippo(home, env, 'recall', 'deploykey', '--json', '--limit', '10');
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

  it('hasGlobal path (searchBothHybrid recallScope) filters global-store rows equally', () => {
    const globalDir = env.HIPPO_HOME;
    initStore(globalDir);
    writeEntry(globalDir, createMemory('global clean deploykey note'));
    writeEntry(globalDir, createMemory('global private deploykey note', { scope: 'slack:private:CG' }));

    const out = hippo(home, env, 'recall', 'deploykey', '--limit', '10');
    expect(out).toContain('global clean deploykey note');
    expect(out).not.toContain('global private deploykey note');
    expect(out).not.toContain(PRIV_SLACK);
  });

  it('hasGlobal path: explicit --scope additively unlocks the requested private scope on the GLOBAL store too', () => {
    // independent-review-critic round 1 med: the additive unlock was only
    // covered on the local-only path.
    const globalDir = env.HIPPO_HOME;
    initStore(globalDir);
    writeEntry(globalDir, createMemory('global clean deploykey note'));
    writeEntry(globalDir, createMemory('global private deploykey note', { scope: 'slack:private:CG' }));

    const out = hippo(home, env, 'recall', 'deploykey', '--scope', 'slack:private:CG', '--limit', '10');
    expect(out).toContain('global private deploykey note');
    expect(out).toContain('global clean deploykey note');
    // Non-requested private scopes stay denied on both stores.
    expect(out).not.toContain(PRIV_SLACK);
    expect(out).not.toContain(PRIV_GITHUB);
  });

  it('private rows cannot starve admitted rows out of the SQL candidate window (codex review P2)', () => {
    // 220 matching private rows > the 200-row default window. Pre-fix, the
    // window filled with private rows in SQL and the JS filter then emptied
    // it, so the one admitted row never surfaced. The SQL pre-window
    // NOT LIKE '%:private:%' exclusion keeps the window for admitted rows.
    const hippoDir = join(home, '.hippo');
    for (let i = 0; i < 220; i++) {
      writeEntry(hippoDir, createMemory(`windowstarve private filler row number ${i}`, { scope: 'slack:private:Cbulk' }));
    }
    writeEntry(hippoDir, createMemory('windowstarve admitted public row'));

    const entries = loadRecallSearchEntries(hippoDir, 'windowstarve', undefined, 'default');
    const contents = entries.map((e) => e.content);
    expect(contents).toContain('windowstarve admitted public row');
    expect(contents.some((c) => c.includes('private filler'))).toBe(false);

    // End-to-end through the CLI for belt and braces.
    const out = hippo(home, env, 'recall', 'windowstarve', '--limit', '10');
    expect(out).toContain('windowstarve admitted public row');
    expect(out).not.toContain('private filler');
  });

  it('hippo explain applies the same rule and prints an honest note', () => {
    const res = spawnSync('node', [HIPPO_BIN, 'explain', 'deploykey'], {
      cwd: home,
      env: { ...process.env, ...env },
      encoding: 'utf-8',
    });
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain(PRIV_SLACK);
    expect(res.stdout).not.toContain(PRIV_GITHUB);
    expect(res.stdout).not.toContain(LEGACY);
    expect(res.stderr).toMatch(/hidden by recall scope policy/);
  });
});
