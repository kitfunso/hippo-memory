/** FE2 staleness-from-code-churn: the invalidate and sleep CLI wiring. */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { createMemory, CHURN_STALE_TAG, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { runCliAs } from '../_helpers/run-cli-as.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry, readEntry } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { initGitRepo, commit, ANCHOR, BEFORE_ANCHOR, AFTER_ANCHOR } from '../_helpers/churn-git-repo.js';

// ---------------------------------------------------------------------------
// CLI wiring: `hippo invalidate --churn` and `hippo sleep`
// ---------------------------------------------------------------------------

// In process, so coverage sees invalidate and sleep; a non-zero exit throws unless the case expects it.
async function runCli(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  opts: { ok?: boolean } = {},
): Promise<{ stdout: string; stderr: string }> {
  const r = await runCliAs(args, { cwd, env });
  if (r.status === 0) return { stdout: r.stdout, stderr: '' };
  if (opts.ok === false) return { stdout: r.stdout, stderr: r.stderr };
  throw new Error(`CLI exit ${r.status}: ${r.stderr}\nstdout: ${r.stdout}`);
}

describe('hippo invalidate --churn (CLI)', () => {
  let repoDir: string;
  let globalRoot: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    repoDir = makeRoot('churn-cli-repo', { init: false });
    globalRoot = makeRoot('churn-cli-global', { init: false });
    initGitRepo(repoDir);
    fs.writeFileSync(path.join(repoDir, 'k.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    env = { ...process.env, HIPPO_HOME: globalRoot, HIPPO_SKIP_AUTO_INTEGRATIONS: '1' };
    await runCli(repoDir, ['init', '--no-hooks', '--no-schedule', '--no-learn'], env);
  });

  it('rejects --churn combined with a pattern', async () => {
    const { stderr } = await runCli(repoDir, ['invalidate', 'somepattern', '--churn'], env, { ok: false });
    expect(stderr).toContain('Usage: hippo invalidate --churn');
  });

  it('rejects --churn combined with --id', async () => {
    const { stderr } = await runCli(repoDir, ['invalidate', '--churn', '--id', 'mem_x'], env, { ok: false });
    expect(stderr).toContain('Usage: hippo invalidate --churn');
  });

  it('dry-run previews the tag without writing, then a live run tags it', async () => {
    const hippoRoot = path.join(repoDir, '.hippo');
    const mem = createMemory('see k.ts for the setup', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tags: [] });
    mem.created = ANCHOR;
    mem.originProject = path.basename(repoDir).toLowerCase();
    writeEntry(hippoRoot, mem);
    fs.writeFileSync(path.join(repoDir, 'k.ts'), 'v2');
    commit(repoDir, AFTER_ANCHOR);

    const dry = await runCli(repoDir, ['invalidate', '--churn', '--dry-run'], env);
    expect(dry.stdout).toContain('WOULD be tagged');
    expect(dry.stdout).toContain(mem.id);
    expect(readEntry(hippoRoot, mem.id)!.tags).not.toContain(CHURN_STALE_TAG);

    const live = await runCli(repoDir, ['invalidate', '--churn'], env);
    expect(live.stdout).toContain('Tagged 1 memories');
    expect(readEntry(hippoRoot, mem.id)!.tags).toContain(CHURN_STALE_TAG);
  });

  it("also tags this repo's memories in the global store", async () => {
    initTestStore(globalRoot);
    const mem = createMemory('see k.ts for the setup', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tags: [] });
    mem.created = ANCHOR;
    mem.originProject = path.basename(repoDir).toLowerCase();
    writeEntry(globalRoot, mem);
    fs.writeFileSync(path.join(repoDir, 'k.ts'), 'v2');
    commit(repoDir, AFTER_ANCHOR);

    await runCli(repoDir, ['invalidate', '--churn'], env);
    expect(readEntry(globalRoot, mem.id)!.tags).toContain(CHURN_STALE_TAG);
  });

  it('exits non-zero when the git read fails', async () => {
    const mem = createMemory('see k.ts for the setup', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tags: [] });
    mem.created = ANCHOR;
    mem.originProject = path.basename(repoDir).toLowerCase();
    writeEntry(path.join(repoDir, '.hippo'), mem);
    execFileSync('git', ['update-ref', '-d', 'HEAD'], { cwd: repoDir });

    const { stderr } = await runCli(repoDir, ['invalidate', '--churn'], env, { ok: false });
    expect(stderr).toContain('Churn-staleness check failed');
  });
});

describe('hippo sleep + config.churnStaleness.enabled (CLI)', () => {
  let repoDir: string;
  let globalRoot: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    repoDir = makeRoot('churn-sleep-repo', { init: false });
    globalRoot = makeRoot('churn-sleep-global', { init: false });
    initGitRepo(repoDir);
    fs.writeFileSync(path.join(repoDir, 'm.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    env = { ...process.env, HIPPO_HOME: globalRoot, HIPPO_SKIP_AUTO_INTEGRATIONS: '1' };
    await runCli(repoDir, ['init', '--no-hooks', '--no-schedule', '--no-learn'], env);
  });

  function setupChurnMemory(hippoRoot: string): string {
    const mem = createMemory('see m.ts for the setup', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tags: [] });
    mem.created = ANCHOR;
    mem.originProject = path.basename(repoDir).toLowerCase();
    writeEntry(hippoRoot, mem);
    fs.writeFileSync(path.join(repoDir, 'm.ts'), 'v2');
    commit(repoDir, AFTER_ANCHOR);
    return mem.id;
  }

  it('does not tag anything on sleep when churnStaleness.enabled is false (default)', async () => {
    const hippoRoot = path.join(repoDir, '.hippo');
    const memId = setupChurnMemory(hippoRoot);

    // Plain `sleep` (no --no-learn) so Phase 1 runs and only the config gate stops the tagging.
    const { stdout } = await runCli(repoDir, ['sleep'], env);
    expect(stdout).not.toContain('churn-stale');
    expect(readEntry(hippoRoot, memId)!.tags).not.toContain(CHURN_STALE_TAG);
  });

  it('tags on sleep when churnStaleness.enabled is true', async () => {
    const hippoRoot = path.join(repoDir, '.hippo');
    fs.writeFileSync(path.join(hippoRoot, 'config.json'), JSON.stringify({ churnStaleness: { enabled: true } }));
    const memId = setupChurnMemory(hippoRoot);

    const { stdout } = await runCli(repoDir, ['sleep'], env);
    expect(stdout).toContain('Tagged 1 memories churn-stale');
    expect(readEntry(hippoRoot, memId)!.tags).toContain(CHURN_STALE_TAG);
  });
});
