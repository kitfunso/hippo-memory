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
import { initStore, writeEntry } from '../src/store.js';
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

  it('JSON suppression summary counts the JS-half scope drops', () => {
    const raw = hippo(home, env, 'recall', 'deploykey', '--json', '--limit', '10');
    const parsed = JSON.parse(raw) as {
      results: Array<{ content?: string; entry?: { content?: string } }>;
      suppressionSummary: { droppedPreRank: number };
    };
    const text = JSON.stringify(parsed.results);
    expect(text).not.toContain(PRIV_SLACK);
    expect(text).not.toContain(PRIV_GITHUB);
    expect(text).not.toContain(LEGACY);
    // The two `<source>:private:*` rows are dropped by the JS regex half
    // (the SQL predicate already excluded unknown:legacy before counting).
    expect(parsed.suppressionSummary.droppedPreRank).toBeGreaterThanOrEqual(2);
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
