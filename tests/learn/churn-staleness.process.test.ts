/** FE2 staleness-from-code-churn: extraction and detection. */
import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { extractChurnRefs, detectChurnStale } from '../../src/domain/learn/invalidation.js';
import { createMemory, CHURN_STALE_TAG, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import * as api from '../../src/api/index.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry, readEntry } from '../_helpers/root-forms.js';
import { initGitRepo, commit, DAY, ANCHOR, BEFORE_ANCHOR, AFTER_ANCHOR } from '../_helpers/churn-git-repo.js';
import { processGit } from '../../src/infra/git-runner.js';

// ---------------------------------------------------------------------------
// extractChurnRefs (pure syntax, no repo access)
// ---------------------------------------------------------------------------

describe('extractChurnRefs', () => {
  it('extracts a plain path reference', () => {
    expect(extractChurnRefs('see src/domain/learn/invalidation.ts for details').paths).toEqual([
      'src/domain/learn/invalidation.ts',
    ]);
  });

  it('strips a :line or :line-line suffix from a path', () => {
    expect(extractChurnRefs('bug at src/cli.ts:120').paths).toEqual(['src/cli.ts']);
    expect(extractChurnRefs('bug at src/cli.ts:120-145').paths).toEqual(['src/cli.ts']);
  });

  it('normalizes backslashes and strips a leading ./', () => {
    expect(extractChurnRefs('see ./src\\domain\\learn\\churn-git.ts').paths).toEqual(['src/domain/learn/churn-git.ts']);
  });

  it('captures an extension whole when a shorter one is its prefix (json/js, tsx/ts)', () => {
    expect(extractChurnRefs('edit package.json first').paths).toEqual(['package.json']);
    expect(extractChurnRefs('see src/App.tsx and tsconfig.json:12').paths).toEqual(['src/App.tsx', 'tsconfig.json']);
  });

  it('ignores a path with an unlisted extension', () => {
    expect(extractChurnRefs('see notes.docx for background').paths).toEqual([]);
  });

  it('extracts a backtick-quoted camelCase symbol', () => {
    expect(extractChurnRefs('call `detectChurnStale` after learn').symbols).toEqual(['detectChurnStale']);
  });

  it('extracts a backtick-quoted symbol with an inner underscore', () => {
    expect(extractChurnRefs('see `resolve_tracked_path` helper').symbols).toEqual(['resolve_tracked_path']);
  });

  it('ignores a short or non-identifier-shaped backtick token', () => {
    expect(extractChurnRefs('the `fix` was small').symbols).toEqual([]);
    expect(extractChurnRefs('the `lowercase` word').symbols).toEqual([]);
  });

  it('extracts an npm script reference', () => {
    expect(extractChurnRefs('run `npm run build:prod` first').scripts).toEqual(['build:prod']);
    expect(extractChurnRefs('use npm run-script test').scripts).toEqual(['test']);
  });

  it('returns empty arrays for content with no references', () => {
    expect(extractChurnRefs('a plain sentence with nothing special')).toEqual({ paths: [], symbols: [], scripts: [] });
  });
});

// ---------------------------------------------------------------------------
// detectChurnStale: real temp git repo + real store
// ---------------------------------------------------------------------------

describe('detectChurnStale', () => {
  let repoDir: string;
  let hippoRoot: string;
  const project = 'churntestproj';

  beforeEach(() => {
    repoDir = makeRoot('churn-repo', { init: false });
    hippoRoot = makeRoot('churn-store');
    initGitRepo(repoDir);
  });

  afterEach(() => {
    fs.rmSync(hippoRoot, { recursive: true, force: true });
  });

  function storeMemory(
    content: string,
    opts: { created?: string; pinned?: boolean; origin?: string | null } = {},
  ): ReturnType<typeof createMemory> {
    const mem = createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tags: [], pinned: opts.pinned });
    if (opts.created) mem.created = opts.created;
    mem.originProject = opts.origin === undefined ? project : opts.origin;
    writeEntry(hippoRoot, mem);
    return mem;
  }

  it('file-changed: a tracked file edited after the memory anchor is evidence', async () => {
    fs.writeFileSync(path.join(repoDir, 'a.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    const mem = storeMemory('see a.ts for the setup', { created: ANCHOR });
    fs.writeFileSync(path.join(repoDir, 'a.ts'), 'v2');
    commit(repoDir, AFTER_ANCHOR);

    const result = await detectChurnStale(
      sqliteStore(hippoRoot),
      { root: repoDir, git: processGit },
      {
        tenantId: 'default',
        projectName: project,
      },
    );
    expect(result.marked).toBe(1);
    expect(result.preview[0].evidence).toBe('file-changed: a.ts');
    expect(readEntry(hippoRoot, mem.id)!.tags).toContain(CHURN_STALE_TAG);
  });

  it('checks rows stamped with the legacy folder name once the project has an id', async () => {
    fs.writeFileSync(path.join(repoDir, 'a.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    storeMemory('see a.ts for the setup', { created: ANCHOR });
    fs.writeFileSync(path.join(repoDir, 'a.ts'), 'v2');
    commit(repoDir, AFTER_ANCHOR);

    const opts = { tenantId: 'default', projectName: 'github.com/acme/churn', dryRun: true };
    expect(
      (await detectChurnStale(sqliteStore(hippoRoot), { root: repoDir, git: processGit }, opts)).preview,
    ).toHaveLength(0);
    expect(
      (
        await detectChurnStale(
          sqliteStore(hippoRoot),
          { root: repoDir, git: processGit },
          { ...opts, legacyName: project },
        )
      ).preview,
    ).toHaveLength(1);
  });

  it('file-deleted: a tracked file removed after the anchor is evidence (--no-renames)', async () => {
    fs.writeFileSync(path.join(repoDir, 'b.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    const mem = storeMemory('see b.ts for the setup', { created: ANCHOR });
    fs.rmSync(path.join(repoDir, 'b.ts'));
    commit(repoDir, AFTER_ANCHOR);

    const result = await detectChurnStale(
      sqliteStore(hippoRoot),
      { root: repoDir, git: processGit },
      {
        tenantId: 'default',
        projectName: project,
      },
    );
    expect(result.marked).toBe(1);
    expect(result.preview[0].evidence).toBe('file-deleted: b.ts');
    expect(readEntry(hippoRoot, mem.id)!.tags).toContain(CHURN_STALE_TAG);
  });

  it('a rename shows as delete+add and is still evidence (--no-renames)', async () => {
    fs.writeFileSync(
      path.join(repoDir, 'old.ts'),
      'v1 has enough content to avoid a similarity-based rename detection false negative',
    );
    commit(repoDir, BEFORE_ANCHOR);
    const mem = storeMemory('see old.ts for the setup', { created: ANCHOR });
    fs.renameSync(path.join(repoDir, 'old.ts'), path.join(repoDir, 'new.ts'));
    commit(repoDir, AFTER_ANCHOR);

    const result = await detectChurnStale(
      sqliteStore(hippoRoot),
      { root: repoDir, git: processGit },
      {
        tenantId: 'default',
        projectName: project,
      },
    );
    expect(result.marked).toBe(1);
    expect(result.preview[0].evidence).toBe('file-deleted: old.ts');
    expect(readEntry(hippoRoot, mem.id)!.tags).toContain(CHURN_STALE_TAG);
  });

  it('symbol-gone: a backtick symbol present at the anchor but absent at HEAD is evidence', async () => {
    fs.writeFileSync(path.join(repoDir, 'c.ts'), 'export function helperSymbolName() {}\n');
    commit(repoDir, BEFORE_ANCHOR);
    const mem = storeMemory('see `helperSymbolName` for the setup', { created: ANCHOR });
    fs.writeFileSync(path.join(repoDir, 'c.ts'), 'export function renamedFunction() {}\n');
    commit(repoDir, AFTER_ANCHOR);

    const result = await detectChurnStale(
      sqliteStore(hippoRoot),
      { root: repoDir, git: processGit },
      {
        tenantId: 'default',
        projectName: project,
      },
    );
    expect(result.marked).toBe(1);
    expect(result.preview[0].evidence).toBe('symbol-gone: `helperSymbolName`');
    expect(readEntry(hippoRoot, mem.id)!.tags).toContain(CHURN_STALE_TAG);
  });

  it('script-gone: an npm script present at the anchor but absent at HEAD is evidence', async () => {
    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ scripts: { oldscript: 'echo hi' } }));
    commit(repoDir, BEFORE_ANCHOR);
    const mem = storeMemory('run `npm run oldscript` to build', { created: ANCHOR });
    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ scripts: { newscript: 'echo hi' } }));
    commit(repoDir, AFTER_ANCHOR);

    const result = await detectChurnStale(
      sqliteStore(hippoRoot),
      { root: repoDir, git: processGit },
      {
        tenantId: 'default',
        projectName: project,
      },
    );
    expect(result.marked).toBe(1);
    expect(result.preview[0].evidence).toBe('script-gone: oldscript');
    expect(readEntry(hippoRoot, mem.id)!.tags).toContain(CHURN_STALE_TAG);
  });

  it('a file changed BEFORE the anchor is not evidence', async () => {
    fs.writeFileSync(path.join(repoDir, 'd.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    fs.writeFileSync(path.join(repoDir, 'd.ts'), 'v2');
    commit(repoDir, new Date(new Date(ANCHOR).getTime() - 1).toISOString());
    const mem = storeMemory('see d.ts for the setup', { created: ANCHOR });

    const result = await detectChurnStale(
      sqliteStore(hippoRoot),
      { root: repoDir, git: processGit },
      {
        tenantId: 'default',
        projectName: project,
      },
    );
    expect(result.marked).toBe(0);
    expect(readEntry(hippoRoot, mem.id)!.tags).not.toContain(CHURN_STALE_TAG);
  });

  it('a path that was never tracked in the repo is ignored (no evidence)', async () => {
    fs.writeFileSync(path.join(repoDir, 'real.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    const mem = storeMemory('see phantom-file-that-never-existed.ts for setup', { created: ANCHOR });

    const result = await detectChurnStale(
      sqliteStore(hippoRoot),
      { root: repoDir, git: processGit },
      {
        tenantId: 'default',
        projectName: project,
      },
    );
    expect(result.marked).toBe(0);
    expect(readEntry(hippoRoot, mem.id)!.tags).not.toContain(CHURN_STALE_TAG);
  });

  it('resolves an absolute path under the repo root and ignores one outside it', async () => {
    const root = fs.realpathSync.native(repoDir).replace(/\\/g, '/');
    fs.writeFileSync(path.join(repoDir, 'n.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    const inside = storeMemory(`see ${root}/n.ts for the setup`, { created: ANCHOR });
    const outside = storeMemory('see /elsewhere/other-repo/n.ts for the setup', { created: ANCHOR });
    fs.writeFileSync(path.join(repoDir, 'n.ts'), 'v2');
    commit(repoDir, AFTER_ANCHOR);

    const result = await detectChurnStale(
      sqliteStore(hippoRoot),
      { root: root, git: processGit },
      {
        tenantId: 'default',
        projectName: project,
      },
    );
    expect(result.preview.map((p) => p.id)).toEqual([inside.id]);
    expect(readEntry(hippoRoot, outside.id)!.tags).not.toContain(CHURN_STALE_TAG);
  });

  it('strips a leading <repoName>/ prefix when the rest is tracked', async () => {
    fs.writeFileSync(path.join(repoDir, 'o.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    const mem = storeMemory(`see ${project}/o.ts for the setup`, { created: ANCHOR });
    fs.writeFileSync(path.join(repoDir, 'o.ts'), 'v2');
    commit(repoDir, AFTER_ANCHOR);

    const result = await detectChurnStale(
      sqliteStore(hippoRoot),
      { root: repoDir, git: processGit },
      {
        tenantId: 'default',
        projectName: project,
      },
    );
    expect(result.preview[0]?.evidence).toBe('file-changed: o.ts');
    expect(readEntry(hippoRoot, mem.id)!.tags).toContain(CHURN_STALE_TAG);
  });

  it('flags a changed package.json (whole-extension capture)', async () => {
    fs.writeFileSync(path.join(repoDir, 'package.json'), '{}');
    commit(repoDir, BEFORE_ANCHOR);
    storeMemory('the version lives in package.json', { created: ANCHOR });
    fs.writeFileSync(path.join(repoDir, 'package.json'), '{"version":"2.0.0"}');
    commit(repoDir, AFTER_ANCHOR);

    const result = await detectChurnStale(
      sqliteStore(hippoRoot),
      { root: repoDir, git: processGit },
      {
        tenantId: 'default',
        projectName: project,
      },
    );
    expect(result.preview[0]?.evidence).toBe('file-changed: package.json');
  });

  it('skips a memory whose created is unparsable instead of throwing', async () => {
    fs.writeFileSync(path.join(repoDir, 'q.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    const mem = storeMemory('see q.ts for the setup', { created: 'not-a-date' });
    fs.writeFileSync(path.join(repoDir, 'q.ts'), 'v2');
    commit(repoDir, AFTER_ANCHOR);

    const result = await detectChurnStale(
      sqliteStore(hippoRoot),
      { root: repoDir, git: processGit },
      {
        tenantId: 'default',
        projectName: project,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.checked).toBe(0);
    expect(readEntry(hippoRoot, mem.id)!.tags).not.toContain(CHURN_STALE_TAG);
  });

  it('skips a pinned memory and reports it in skippedPinned', async () => {
    fs.writeFileSync(path.join(repoDir, 'e.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    const mem = storeMemory('see e.ts for the setup', { created: ANCHOR, pinned: true });
    fs.writeFileSync(path.join(repoDir, 'e.ts'), 'v2');
    commit(repoDir, AFTER_ANCHOR);

    const result = await detectChurnStale(
      sqliteStore(hippoRoot),
      { root: repoDir, git: processGit },
      {
        tenantId: 'default',
        projectName: project,
      },
    );
    expect(result.marked).toBe(0);
    expect(result.skippedPinned).toContain(mem.id);
    expect(readEntry(hippoRoot, mem.id)!.tags).not.toContain(CHURN_STALE_TAG);
  });

  it('skips a memory from a different origin_project', async () => {
    fs.writeFileSync(path.join(repoDir, 'f.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    const mem = storeMemory('see f.ts for the setup', { created: ANCHOR, origin: 'some-other-project' });
    fs.writeFileSync(path.join(repoDir, 'f.ts'), 'v2');
    commit(repoDir, AFTER_ANCHOR);

    const result = await detectChurnStale(
      sqliteStore(hippoRoot),
      { root: repoDir, git: processGit },
      {
        tenantId: 'default',
        projectName: project,
      },
    );
    expect(result.marked).toBe(0);
    expect(readEntry(hippoRoot, mem.id)!.tags).not.toContain(CHURN_STALE_TAG);
  });

  it('skips a memory with a null/empty origin_project (deny by default)', async () => {
    fs.writeFileSync(path.join(repoDir, 'g.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    const mem = storeMemory('see g.ts for the setup', { created: ANCHOR, origin: null });
    fs.writeFileSync(path.join(repoDir, 'g.ts'), 'v2');
    commit(repoDir, AFTER_ANCHOR);

    const result = await detectChurnStale(
      sqliteStore(hippoRoot),
      { root: repoDir, git: processGit },
      {
        tenantId: 'default',
        projectName: project,
      },
    );
    expect(result.marked).toBe(0);
    expect(readEntry(hippoRoot, mem.id)!.tags).not.toContain(CHURN_STALE_TAG);
  });

  it('is idempotent: a rerun reports the same memory as alreadyMarked, not marked again', async () => {
    fs.writeFileSync(path.join(repoDir, 'h.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    storeMemory('see h.ts for the setup', { created: ANCHOR });
    fs.writeFileSync(path.join(repoDir, 'h.ts'), 'v2');
    commit(repoDir, AFTER_ANCHOR);

    const first = await detectChurnStale(
      sqliteStore(hippoRoot),
      { root: repoDir, git: processGit },
      {
        tenantId: 'default',
        projectName: project,
      },
    );
    expect(first.marked).toBe(1);
    const second = await detectChurnStale(
      sqliteStore(hippoRoot),
      { root: repoDir, git: processGit },
      {
        tenantId: 'default',
        projectName: project,
      },
    );
    expect(second.marked).toBe(0);
    expect(second.alreadyMarked).toBe(1);
  });

  it('dry run reports the candidate but writes nothing', async () => {
    fs.writeFileSync(path.join(repoDir, 'i.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    const mem = storeMemory('see i.ts for the setup', { created: ANCHOR });
    fs.writeFileSync(path.join(repoDir, 'i.ts'), 'v2');
    commit(repoDir, AFTER_ANCHOR);

    const result = await detectChurnStale(
      sqliteStore(hippoRoot),
      { root: repoDir, git: processGit },
      {
        tenantId: 'default',
        projectName: project,
        dryRun: true,
      },
    );
    expect(result.dryRun).toBe(true);
    expect(result.marked).toBe(1);
    expect(readEntry(hippoRoot, mem.id)!.tags).not.toContain(CHURN_STALE_TAG);
  });

  it('a positive outcome recorded after the churn moves the anchor forward, clearing the staleness', async () => {
    fs.writeFileSync(path.join(repoDir, 'j.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    const mem = storeMemory('see j.ts for the setup', { created: ANCHOR });
    fs.writeFileSync(path.join(repoDir, 'j.ts'), 'v2');
    commit(repoDir, AFTER_ANCHOR);

    const ctx: FullContext = apiCtx(hippoRoot, 'default', api.adminActor('test'));
    await api.outcome(ctx, [mem.id], true); // confirmedAt lands after the churn commit, anchor moves past it

    const result = await detectChurnStale(
      sqliteStore(hippoRoot),
      { root: repoDir, git: processGit },
      {
        tenantId: 'default',
        projectName: project,
      },
    );
    expect(result.marked).toBe(0);
  });

  it('a merge after the anchor of a branch commit dated before it is evidence (first-parent diff)', async () => {
    fs.writeFileSync(path.join(repoDir, 'm.ts'), 'v1');
    commit(repoDir, new Date(new Date(BEFORE_ANCHOR).getTime() - DAY).toISOString());
    const mainline = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['checkout', '-q', '-b', 'side'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'm.ts'), 'v2');
    commit(repoDir, BEFORE_ANCHOR);
    execFileSync('git', ['checkout', '-q', mainline], { cwd: repoDir });
    const mem = storeMemory('see m.ts for the setup', { created: ANCHOR });
    execFileSync('git', ['merge', '-q', '--no-ff', '-m', 'merge side', 'side'], {
      cwd: repoDir,
      env: { ...process.env, GIT_AUTHOR_DATE: AFTER_ANCHOR, GIT_COMMITTER_DATE: AFTER_ANCHOR },
    });

    const result = await detectChurnStale(
      sqliteStore(hippoRoot),
      { root: repoDir, git: processGit },
      {
        tenantId: 'default',
        projectName: project,
      },
    );
    expect(result.preview[0]?.evidence).toBe('file-changed: m.ts');
    expect(readEntry(hippoRoot, mem.id)!.tags).toContain(CHURN_STALE_TAG);
  });

  it('resolves the anchor snapshot on first-parent history, so a merged side-branch removal counts', async () => {
    fs.writeFileSync(path.join(repoDir, 's.ts'), 'export function mergedAwaySymbol() {}\n');
    commit(repoDir, new Date(new Date(BEFORE_ANCHOR).getTime() - DAY).toISOString());
    const mainline = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['checkout', '-q', '-b', 'side'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 's.ts'), 'export function replacement() {}\n');
    commit(repoDir, BEFORE_ANCHOR);
    execFileSync('git', ['checkout', '-q', mainline], { cwd: repoDir });
    storeMemory('call `mergedAwaySymbol` first', { created: ANCHOR });
    execFileSync('git', ['merge', '-q', '--no-ff', '-m', 'merge side', 'side'], {
      cwd: repoDir,
      env: { ...process.env, GIT_AUTHOR_DATE: AFTER_ANCHOR, GIT_COMMITTER_DATE: AFTER_ANCHOR },
    });

    const result = await detectChurnStale(
      sqliteStore(hippoRoot),
      { root: repoDir, git: processGit },
      {
        tenantId: 'default',
        projectName: project,
        dryRun: true,
      },
    );
    expect(result.preview[0]?.evidence).toBe('symbol-gone: `mergedAwaySymbol`');
  });

  it('reads tracked files from HEAD, not the index (a staged removal does not hide a change)', async () => {
    fs.writeFileSync(path.join(repoDir, 'r.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    storeMemory('see r.ts for the setup', { created: ANCHOR });
    fs.writeFileSync(path.join(repoDir, 'r.ts'), 'v2');
    commit(repoDir, AFTER_ANCHOR);
    execFileSync('git', ['rm', '-q', '--cached', 'r.ts'], { cwd: repoDir });

    const result = await detectChurnStale(
      sqliteStore(hippoRoot),
      { root: repoDir, git: processGit },
      {
        tenantId: 'default',
        projectName: project,
        dryRun: true,
      },
    );
    expect(result.preview[0]?.evidence).toBe('file-changed: r.ts');
  });

  it('script-gone fires when package.json itself was deleted after the anchor', async () => {
    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ scripts: { goner: 'echo hi' } }));
    fs.writeFileSync(path.join(repoDir, 'keep.txt'), 'x');
    commit(repoDir, BEFORE_ANCHOR);
    storeMemory('run `npm run goner` to build', { created: ANCHOR });
    fs.rmSync(path.join(repoDir, 'package.json'));
    commit(repoDir, AFTER_ANCHOR);

    const result = await detectChurnStale(
      sqliteStore(hippoRoot),
      { root: repoDir, git: processGit },
      {
        tenantId: 'default',
        projectName: project,
        dryRun: true,
      },
    );
    expect(result.preview[0]?.evidence).toBe('script-gone: goner');
  });
});
