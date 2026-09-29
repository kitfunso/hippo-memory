// Memories seeded from git history never reach the global store on their own;
// a hand-run share or promote of one still does. Real stores and the real CLI.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sleep, adminActor } from '../src/api.js';
import { loadConfig } from '../src/config.js';
import { createMemory } from '../src/memory.js';
import { autoShare, getGlobalRoot, promoteToGlobal, shareMemory, transferScore } from '../src/shared.js';
import { initStore, loadAllEntries, writeEntry } from '../src/store.js';

const HIPPO_BIN = join(process.cwd(), 'bin', 'hippo.js');
const SEED = 'fix: retry the upload when the storage token expires mid-transfer';
const ORDINARY = 'gotcha: powershell 5.1 has no pipeline chain operators, use if blocks';

function globalContents(): string[] {
  return loadAllEntries(getGlobalRoot()).map((e) => e.content);
}

describe('git-learned rows and the global store', () => {
  let tmp: string;
  let hippoRoot: string;
  let seedId: string;
  let origHippoHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'hippo-gitshare-'));
    hippoRoot = join(tmp, 'proj', '.hippo');
    initStore(hippoRoot);
    origHippoHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = join(tmp, 'global');
    // The tags learnFromRepo gives every seed.
    const seed = createMemory(SEED, { tags: ['error', 'git-learned'], source: 'git-learn', tenantId: 'default' });
    writeEntry(hippoRoot, seed);
    writeEntry(hippoRoot, createMemory(ORDINARY, { tags: ['error'], tenantId: 'default' }));
    seedId = seed.id;
    expect(transferScore(seed)).toBeGreaterThanOrEqual(0.6);
  });

  afterEach(() => {
    if (origHippoHome !== undefined) process.env.HIPPO_HOME = origHippoHome;
    else delete process.env.HIPPO_HOME;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('autoShare copies the ordinary error row and skips the git-learned one', () => {
    const stats = { secretSkipped: 0, neverAutoShareSkipped: 0 };
    const shared = autoShare(hippoRoot, { stats });
    expect(shared.map((e) => e.content)).toEqual([ORDINARY]);
    expect(globalContents()).toEqual([ORDINARY]);
    expect(stats.neverAutoShareSkipped).toBe(1);
  });

  it('sleep with autoShareOnSleep on does not copy the git-learned row', async () => {
    expect(loadConfig(hippoRoot).autoShareOnSleep).toBe(true);
    const result = await sleep({ hippoRoot, tenantId: 'default', actor: adminActor('test:gitshare') }, {});
    expect(result.shared).toBe(1);
    expect(globalContents()).toEqual([ORDINARY]);
  });

  it('a hand-run share of a git-learned row still copies it', () => {
    expect(shareMemory(hippoRoot, seedId)?.content).toBe(SEED);
    expect(globalContents()).toEqual([SEED]);
  });

  it('a hand-run promote of a git-learned row still copies it', () => {
    expect(promoteToGlobal(hippoRoot, seedId).content).toBe(SEED);
    expect(globalContents()).toEqual([SEED]);
  });
});

describe('hippo share --auto --dry-run', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-gitshare-cli-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('lists an ordinary error memory but not a seed hippo init learned from git', () => {
    const proj = join(root, 'proj');
    const home = join(root, 'home');
    for (const dir of [proj, home, join(root, 'appdata')]) mkdirSync(dir, { recursive: true });
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'user.name=Test User', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: proj, stdio: 'ignore' });
    };
    git('init');
    git('commit', '--allow-empty', '-m', SEED);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HIPPO_HOME: join(root, 'global'),
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(root, 'appdata'),
      HIPPO_SKIP_AUTO_INTEGRATIONS: '1',
    };
    for (const key of ['ANTHROPIC_API_KEY', 'TYPESAFE_API_KEY', 'HIPPO_TENANT']) delete env[key];
    const hippo = (...args: string[]): string => {
      const res = spawnSync('node', [HIPPO_BIN, ...args], { cwd: proj, env, encoding: 'utf-8', timeout: 20_000 });
      expect(res.status, res.stderr).toBe(0);
      return res.stdout;
    };

    hippo('init', '--no-hooks', '--no-schedule');
    hippo('remember', ORDINARY, '--error');
    const entries = loadAllEntries(join(proj, '.hippo'));
    const seeds = entries.filter((e) => e.source === 'git-learn');
    const ordinaryId = entries.find((e) => e.content === ORDINARY)?.id;
    expect(seeds).toHaveLength(1);
    expect(transferScore(seeds[0])).toBeGreaterThanOrEqual(0.6);

    const out = hippo('share', '--auto', '--dry-run');
    expect(out).toContain('Would share 1 memories');
    expect(out).toContain(ordinaryId ?? 'the remembered row');
    expect(out).not.toContain(seeds[0].id);
  });
});
