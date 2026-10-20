// Memories seeded from git history never reach the global store on their own;
// a hand-run share or promote of one still does. Real stores and the real CLI.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sleep, adminActor } from '../../src/api/index.js';
import { loadConfig } from '../../src/base/config/config.js';
import { buildDag, buildEntityProfiles } from '../../src/domain/consolidate/dag.js';
import { storeExtractedFacts, type ExtractedFact } from '../../src/domain/learn/extract.js';
import { createMemory, type MemoryEntry, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { autoShare, shareMemory, transferScore } from '../../src/domain/sharing/share.js';
import { getGlobalRoot } from '../../src/domain/sharing/global-store.js';
import { hippoRun } from '../_helpers/spawn-hippo.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { sharingStores } from '../_helpers/sharing-stores.js';
import { makeRoot } from '../_helpers/make-root.js';
import { copyToGlobal, writeEntry, loadAllEntries } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { ALL_TENANTS } from '../../src/base/util/tenant.js';
const SEED = 'fix: retry the upload when the storage token expires mid-transfer';
const ORDINARY = 'gotcha: powershell 5.1 has no pipeline chain operators, use if blocks';

function globalContents(): string[] {
  return loadAllEntries(getGlobalRoot(), 'default').map((e) => e.content);
}

describe('git-learned rows and the global store', () => {
  let tmp: string;
  let hippoRoot: string;
  let seed: MemoryEntry;

  beforeEach(() => {
    tmp = makeRoot('gitshare', { init: false });
    hippoRoot = join(tmp, 'proj', '.hippo');
    initTestStore(hippoRoot);
    vi.stubEnv('HIPPO_HOME', join(tmp, 'global'));
    // The tags learnFromRepo gives every seed.
    seed = createMemory(SEED, {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      tags: ['error', 'git-learned'],
      source: 'git-learn',
      tenantId: 'default',
    });
    writeEntry(hippoRoot, seed);
    writeEntry(
      hippoRoot,
      createMemory(ORDINARY, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tags: ['error'], tenantId: 'default' }),
    );
    expect(transferScore(seed)).toBeGreaterThanOrEqual(0.6);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('autoShare copies the ordinary error row and skips the git-learned one', async () => {
    const stats = { secretSkipped: 0, neverAutoShareSkipped: 0 };
    const shared = await autoShare(...sharingStores(hippoRoot), { tenantId: ALL_TENANTS, stats });
    expect(shared.map((e) => e.content)).toEqual([ORDINARY]);
    expect(globalContents()).toEqual([ORDINARY]);
    expect(stats.neverAutoShareSkipped).toBe(1);
  });

  it('sleep with autoShareOnSleep on does not copy the git-learned row', async () => {
    expect(loadConfig(hippoRoot).autoShareOnSleep).toBe(true);
    const result = await sleep(apiCtx(hippoRoot, 'default', adminActor('test:gitshare')), {});
    expect(result.shared).toBe(1);
    expect(globalContents()).toEqual([ORDINARY]);
  });

  it('a hand-run share of a git-learned row still copies it', async () => {
    expect((await shareMemory(...sharingStores(hippoRoot), seed.id, { tenantId: 'default' }))?.content).toBe(SEED);
    expect(globalContents()).toEqual([SEED]);
  });

  it('a hand-run promote of a git-learned row still copies it', async () => {
    expect((await copyToGlobal(hippoRoot, seed.id)).content).toBe(SEED);
    expect(globalContents()).toEqual([SEED]);
  });

  it('a fact extracted from a git-learned row keeps the tag and stays local after three recalls', async () => {
    const [fact] = storeExtractedFacts(
      sqliteSyncStore(hippoRoot).localFiles.learning,
      seed,
      [
        {
          content: 'The uploader retries when the storage token expires mid-transfer.',
          tags: ['topic:upload'],
          valence: 'neutral',
        },
      ],
      DEFAULT_HALF_LIFE_DAYS,
    );
    expect(fact.tags).toContain('git-learned');
    const recalled = { ...fact, retrievalCount: 3 };
    writeEntry(hippoRoot, recalled);
    expect(transferScore(recalled)).toBeGreaterThanOrEqual(0.6);
    await autoShare(...sharingStores(hippoRoot), { tenantId: ALL_TENANTS });
    expect(globalContents()).toEqual([ORDINARY]);
  });

  it('DAG summaries and entity profiles built over git-learned facts keep the tag', async () => {
    let calls = 0;
    // Stands in for the summary model, so no API key is read.
    const fetcher = async (): Promise<Response> =>
      new Response(
        JSON.stringify({ content: [{ text: `Upload retry summary number ${++calls} for the storage token.` }] }),
        { status: 200 },
      );
    const facts = storeExtractedFacts(
      sqliteSyncStore(hippoRoot).localFiles.learning,
      seed,
      [1, 2, 3, 4, 5, 6].map((n): ExtractedFact => ({
        content: `Upload fact ${n}: the storage token can expire mid-transfer.`,
        tags: ['topic:upload'],
        valence: 'neutral',
      })),
      DEFAULT_HALF_LIFE_DAYS,
    ).map((f) => ({ ...f, dagLevel: 1 }));
    await buildDag(sqliteSyncStore(hippoRoot).localFiles, facts.slice(0, 3), {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      apiKey: 'test',
      fetcher,
    });
    await buildDag(sqliteSyncStore(hippoRoot).localFiles, facts.slice(3), {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      apiKey: 'test',
      fetcher,
    });
    const summaries = loadAllEntries(hippoRoot, 'default').filter((e) => e.dagLevel === 2);
    expect(summaries).toHaveLength(2);
    for (const s of summaries) expect(s.tags).toContain('git-learned');

    await buildEntityProfiles(sqliteSyncStore(hippoRoot).localFiles, summaries, {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      apiKey: 'test',
      fetcher,
    });
    const profiles = loadAllEntries(hippoRoot, 'default').filter((e) => e.dagLevel === 3);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].tags).toContain('git-learned');
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
      execFileSync(
        'git',
        ['-c', 'user.name=Test User', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
        { cwd: proj, stdio: 'ignore' },
      );
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
      const res = hippoRun(args, { cwd: proj, env, timeout: 20_000, exe: 'node' });
      expect(res.status, res.stderr).toBe(0);
      return res.stdout;
    };

    hippo('init', '--no-hooks', '--no-schedule');
    hippo('remember', ORDINARY, '--error');
    const entries = loadAllEntries(join(proj, '.hippo'), 'default');
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
