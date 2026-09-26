/** FE2 staleness-from-code-churn: extraction, detection, outcome-clearing, rank, config, CLI. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync, execFileSync } from 'child_process';
import {
  extractChurnRefs,
  detectChurnStale,
} from '../src/invalidation.js';
import { initStore, writeEntry, readEntry } from '../src/store.js';
import { createMemory, CHURN_STALE_TAG } from '../src/memory.js';
import { search, hybridSearch, physicsSearch, CHURN_STALE_RANK_MULTIPLIER } from '../src/search.js';
import { openHippoDb } from '../src/db.js';
import { savePhysicsState } from '../src/physics-state.js';
import type { PhysicsParticle } from '../src/physics.js';
import { loadConfig } from '../src/config.js';
import * as api from '../src/api.js';

// ---------------------------------------------------------------------------
// extractChurnRefs (pure syntax, no repo access)
// ---------------------------------------------------------------------------

describe('extractChurnRefs', () => {
  it('extracts a plain path reference', () => {
    expect(extractChurnRefs('see src/invalidation.ts for details').paths).toEqual(['src/invalidation.ts']);
  });

  it('strips a :line or :line-line suffix from a path', () => {
    expect(extractChurnRefs('bug at src/cli.ts:120').paths).toEqual(['src/cli.ts']);
    expect(extractChurnRefs('bug at src/cli.ts:120-145').paths).toEqual(['src/cli.ts']);
  });

  it('normalizes backslashes and strips a leading ./', () => {
    expect(extractChurnRefs('see ./src\\churn-git.ts').paths).toEqual(['src/churn-git.ts']);
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

function initGitRepo(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test User"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'ignore' });
}

function commit(dir: string, isoDate: string, message = 'commit'): void {
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', message, '--allow-empty'], {
    cwd: dir,
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate },
  });
}

const DAY = 24 * 60 * 60 * 1000;
const ANCHOR = '2026-01-01T00:00:00.000Z';
const BEFORE_ANCHOR = new Date(new Date(ANCHOR).getTime() - 10 * DAY).toISOString();
const AFTER_ANCHOR = new Date(new Date(ANCHOR).getTime() + 10 * DAY).toISOString();

describe('detectChurnStale', () => {
  let repoDir: string;
  let hippoRoot: string;
  const project = 'churntestproj';

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-churn-repo-'));
    hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-churn-store-'));
    initStore(hippoRoot);
    initGitRepo(repoDir);
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(hippoRoot, { recursive: true, force: true });
  });

  function storeMemory(content: string, opts: { created?: string; pinned?: boolean; origin?: string | null } = {}): ReturnType<typeof createMemory> {
    const mem = createMemory(content, { tags: [], pinned: opts.pinned });
    if (opts.created) mem.created = opts.created;
    mem.origin_project = opts.origin === undefined ? project : opts.origin;
    writeEntry(hippoRoot, mem);
    return mem;
  }

  it('file-changed: a tracked file edited after the memory anchor is evidence', () => {
    fs.writeFileSync(path.join(repoDir, 'a.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    const mem = storeMemory('see a.ts for the setup', { created: ANCHOR });
    fs.writeFileSync(path.join(repoDir, 'a.ts'), 'v2');
    commit(repoDir, AFTER_ANCHOR);

    const result = detectChurnStale(hippoRoot, repoDir, { tenantId: 'default', projectName: project });
    expect(result.marked).toBe(1);
    expect(result.preview[0].evidence).toBe('file-changed: a.ts');
    expect(readEntry(hippoRoot, mem.id)!.tags).toContain(CHURN_STALE_TAG);
  });

  it('file-deleted: a tracked file removed after the anchor is evidence (--no-renames)', () => {
    fs.writeFileSync(path.join(repoDir, 'b.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    const mem = storeMemory('see b.ts for the setup', { created: ANCHOR });
    fs.rmSync(path.join(repoDir, 'b.ts'));
    commit(repoDir, AFTER_ANCHOR);

    const result = detectChurnStale(hippoRoot, repoDir, { tenantId: 'default', projectName: project });
    expect(result.marked).toBe(1);
    expect(result.preview[0].evidence).toBe('file-deleted: b.ts');
    expect(readEntry(hippoRoot, mem.id)!.tags).toContain(CHURN_STALE_TAG);
  });

  it('a rename shows as delete+add and is still evidence (--no-renames)', () => {
    fs.writeFileSync(path.join(repoDir, 'old.ts'), 'v1 has enough content to avoid a similarity-based rename detection false negative');
    commit(repoDir, BEFORE_ANCHOR);
    const mem = storeMemory('see old.ts for the setup', { created: ANCHOR });
    fs.renameSync(path.join(repoDir, 'old.ts'), path.join(repoDir, 'new.ts'));
    commit(repoDir, AFTER_ANCHOR);

    const result = detectChurnStale(hippoRoot, repoDir, { tenantId: 'default', projectName: project });
    expect(result.marked).toBe(1);
    expect(result.preview[0].evidence).toBe('file-deleted: old.ts');
    expect(readEntry(hippoRoot, mem.id)!.tags).toContain(CHURN_STALE_TAG);
  });

  it('symbol-gone: a backtick symbol present at the anchor but absent at HEAD is evidence', () => {
    fs.writeFileSync(path.join(repoDir, 'c.ts'), 'export function helperSymbolName() {}\n');
    commit(repoDir, BEFORE_ANCHOR);
    const mem = storeMemory('see `helperSymbolName` for the setup', { created: ANCHOR });
    fs.writeFileSync(path.join(repoDir, 'c.ts'), 'export function renamedFunction() {}\n');
    commit(repoDir, AFTER_ANCHOR);

    const result = detectChurnStale(hippoRoot, repoDir, { tenantId: 'default', projectName: project });
    expect(result.marked).toBe(1);
    expect(result.preview[0].evidence).toBe('symbol-gone: `helperSymbolName`');
    expect(readEntry(hippoRoot, mem.id)!.tags).toContain(CHURN_STALE_TAG);
  });

  it('script-gone: an npm script present at the anchor but absent at HEAD is evidence', () => {
    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ scripts: { oldscript: 'echo hi' } }));
    commit(repoDir, BEFORE_ANCHOR);
    const mem = storeMemory('run `npm run oldscript` to build', { created: ANCHOR });
    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ scripts: { newscript: 'echo hi' } }));
    commit(repoDir, AFTER_ANCHOR);

    const result = detectChurnStale(hippoRoot, repoDir, { tenantId: 'default', projectName: project });
    expect(result.marked).toBe(1);
    expect(result.preview[0].evidence).toBe('script-gone: oldscript');
    expect(readEntry(hippoRoot, mem.id)!.tags).toContain(CHURN_STALE_TAG);
  });

  it('a file changed BEFORE the anchor is not evidence', () => {
    fs.writeFileSync(path.join(repoDir, 'd.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    fs.writeFileSync(path.join(repoDir, 'd.ts'), 'v2');
    commit(repoDir, new Date(new Date(ANCHOR).getTime() - 1).toISOString());
    const mem = storeMemory('see d.ts for the setup', { created: ANCHOR });

    const result = detectChurnStale(hippoRoot, repoDir, { tenantId: 'default', projectName: project });
    expect(result.marked).toBe(0);
    expect(readEntry(hippoRoot, mem.id)!.tags).not.toContain(CHURN_STALE_TAG);
  });

  it('a path that was never tracked in the repo is ignored (no evidence)', () => {
    fs.writeFileSync(path.join(repoDir, 'real.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    const mem = storeMemory('see phantom-file-that-never-existed.ts for setup', { created: ANCHOR });

    const result = detectChurnStale(hippoRoot, repoDir, { tenantId: 'default', projectName: project });
    expect(result.marked).toBe(0);
    expect(readEntry(hippoRoot, mem.id)!.tags).not.toContain(CHURN_STALE_TAG);
  });

  it('resolves an absolute path under the repo root and ignores one outside it', () => {
    const root = fs.realpathSync.native(repoDir).replace(/\\/g, '/');
    fs.writeFileSync(path.join(repoDir, 'n.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    const inside = storeMemory(`see ${root}/n.ts for the setup`, { created: ANCHOR });
    const outside = storeMemory('see /elsewhere/other-repo/n.ts for the setup', { created: ANCHOR });
    fs.writeFileSync(path.join(repoDir, 'n.ts'), 'v2');
    commit(repoDir, AFTER_ANCHOR);

    const result = detectChurnStale(hippoRoot, root, { tenantId: 'default', projectName: project });
    expect(result.preview.map((p) => p.id)).toEqual([inside.id]);
    expect(readEntry(hippoRoot, outside.id)!.tags).not.toContain(CHURN_STALE_TAG);
  });

  it('strips a leading <repoName>/ prefix when the rest is tracked', () => {
    fs.writeFileSync(path.join(repoDir, 'o.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    const mem = storeMemory(`see ${project}/o.ts for the setup`, { created: ANCHOR });
    fs.writeFileSync(path.join(repoDir, 'o.ts'), 'v2');
    commit(repoDir, AFTER_ANCHOR);

    const result = detectChurnStale(hippoRoot, repoDir, { tenantId: 'default', projectName: project });
    expect(result.preview[0]?.evidence).toBe('file-changed: o.ts');
    expect(readEntry(hippoRoot, mem.id)!.tags).toContain(CHURN_STALE_TAG);
  });

  it('flags a changed package.json (whole-extension capture)', () => {
    fs.writeFileSync(path.join(repoDir, 'package.json'), '{}');
    commit(repoDir, BEFORE_ANCHOR);
    storeMemory('the version lives in package.json', { created: ANCHOR });
    fs.writeFileSync(path.join(repoDir, 'package.json'), '{"version":"2.0.0"}');
    commit(repoDir, AFTER_ANCHOR);

    const result = detectChurnStale(hippoRoot, repoDir, { tenantId: 'default', projectName: project });
    expect(result.preview[0]?.evidence).toBe('file-changed: package.json');
  });

  it('skips a memory whose created is unparsable instead of throwing', () => {
    fs.writeFileSync(path.join(repoDir, 'q.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    const mem = storeMemory('see q.ts for the setup', { created: 'not-a-date' });
    fs.writeFileSync(path.join(repoDir, 'q.ts'), 'v2');
    commit(repoDir, AFTER_ANCHOR);

    const result = detectChurnStale(hippoRoot, repoDir, { tenantId: 'default', projectName: project });
    expect(result.error).toBeUndefined();
    expect(result.checked).toBe(0);
    expect(readEntry(hippoRoot, mem.id)!.tags).not.toContain(CHURN_STALE_TAG);
  });

  it('skips a pinned memory and reports it in skippedPinned', () => {
    fs.writeFileSync(path.join(repoDir, 'e.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    const mem = storeMemory('see e.ts for the setup', { created: ANCHOR, pinned: true });
    fs.writeFileSync(path.join(repoDir, 'e.ts'), 'v2');
    commit(repoDir, AFTER_ANCHOR);

    const result = detectChurnStale(hippoRoot, repoDir, { tenantId: 'default', projectName: project });
    expect(result.marked).toBe(0);
    expect(result.skippedPinned).toContain(mem.id);
    expect(readEntry(hippoRoot, mem.id)!.tags).not.toContain(CHURN_STALE_TAG);
  });

  it('skips a memory from a different origin_project', () => {
    fs.writeFileSync(path.join(repoDir, 'f.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    const mem = storeMemory('see f.ts for the setup', { created: ANCHOR, origin: 'some-other-project' });
    fs.writeFileSync(path.join(repoDir, 'f.ts'), 'v2');
    commit(repoDir, AFTER_ANCHOR);

    const result = detectChurnStale(hippoRoot, repoDir, { tenantId: 'default', projectName: project });
    expect(result.marked).toBe(0);
    expect(readEntry(hippoRoot, mem.id)!.tags).not.toContain(CHURN_STALE_TAG);
  });

  it('skips a memory with a null/empty origin_project (deny by default)', () => {
    fs.writeFileSync(path.join(repoDir, 'g.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    const mem = storeMemory('see g.ts for the setup', { created: ANCHOR, origin: null });
    fs.writeFileSync(path.join(repoDir, 'g.ts'), 'v2');
    commit(repoDir, AFTER_ANCHOR);

    const result = detectChurnStale(hippoRoot, repoDir, { tenantId: 'default', projectName: project });
    expect(result.marked).toBe(0);
    expect(readEntry(hippoRoot, mem.id)!.tags).not.toContain(CHURN_STALE_TAG);
  });

  it('is idempotent: a rerun reports the same memory as alreadyMarked, not marked again', () => {
    fs.writeFileSync(path.join(repoDir, 'h.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    storeMemory('see h.ts for the setup', { created: ANCHOR });
    fs.writeFileSync(path.join(repoDir, 'h.ts'), 'v2');
    commit(repoDir, AFTER_ANCHOR);

    const first = detectChurnStale(hippoRoot, repoDir, { tenantId: 'default', projectName: project });
    expect(first.marked).toBe(1);
    const second = detectChurnStale(hippoRoot, repoDir, { tenantId: 'default', projectName: project });
    expect(second.marked).toBe(0);
    expect(second.alreadyMarked).toBe(1);
  });

  it('dry run reports the candidate but writes nothing', () => {
    fs.writeFileSync(path.join(repoDir, 'i.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    const mem = storeMemory('see i.ts for the setup', { created: ANCHOR });
    fs.writeFileSync(path.join(repoDir, 'i.ts'), 'v2');
    commit(repoDir, AFTER_ANCHOR);

    const result = detectChurnStale(hippoRoot, repoDir, { tenantId: 'default', projectName: project, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.marked).toBe(1);
    expect(readEntry(hippoRoot, mem.id)!.tags).not.toContain(CHURN_STALE_TAG);
  });

  it('a positive outcome recorded after the churn moves the anchor forward, clearing the staleness', () => {
    fs.writeFileSync(path.join(repoDir, 'j.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    const mem = storeMemory('see j.ts for the setup', { created: ANCHOR });
    fs.writeFileSync(path.join(repoDir, 'j.ts'), 'v2');
    commit(repoDir, AFTER_ANCHOR);

    const ctx: api.Context = { hippoRoot, tenantId: 'default', actor: api.adminActor('test') };
    api.outcome(ctx, [mem.id], true); // confirmedAt lands after the churn commit, anchor moves past it

    const result = detectChurnStale(hippoRoot, repoDir, { tenantId: 'default', projectName: project });
    expect(result.marked).toBe(0);
  });

  it('a merge after the anchor of a branch commit dated before it is evidence (first-parent diff)', () => {
    fs.writeFileSync(path.join(repoDir, 'm.ts'), 'v1');
    commit(repoDir, new Date(new Date(BEFORE_ANCHOR).getTime() - DAY).toISOString());
    const mainline = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
    execFileSync('git', ['checkout', '-q', '-b', 'side'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'm.ts'), 'v2');
    commit(repoDir, BEFORE_ANCHOR);
    execFileSync('git', ['checkout', '-q', mainline], { cwd: repoDir });
    const mem = storeMemory('see m.ts for the setup', { created: ANCHOR });
    execFileSync('git', ['merge', '-q', '--no-ff', '-m', 'merge side', 'side'], {
      cwd: repoDir,
      env: { ...process.env, GIT_AUTHOR_DATE: AFTER_ANCHOR, GIT_COMMITTER_DATE: AFTER_ANCHOR },
    });

    const result = detectChurnStale(hippoRoot, repoDir, { tenantId: 'default', projectName: project });
    expect(result.preview[0]?.evidence).toBe('file-changed: m.ts');
    expect(readEntry(hippoRoot, mem.id)!.tags).toContain(CHURN_STALE_TAG);
  });

  it('resolves the anchor snapshot on first-parent history, so a merged side-branch removal counts', () => {
    fs.writeFileSync(path.join(repoDir, 's.ts'), 'export function mergedAwaySymbol() {}\n');
    commit(repoDir, new Date(new Date(BEFORE_ANCHOR).getTime() - DAY).toISOString());
    const mainline = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
    execFileSync('git', ['checkout', '-q', '-b', 'side'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 's.ts'), 'export function replacement() {}\n');
    commit(repoDir, BEFORE_ANCHOR);
    execFileSync('git', ['checkout', '-q', mainline], { cwd: repoDir });
    storeMemory('call `mergedAwaySymbol` first', { created: ANCHOR });
    execFileSync('git', ['merge', '-q', '--no-ff', '-m', 'merge side', 'side'], {
      cwd: repoDir,
      env: { ...process.env, GIT_AUTHOR_DATE: AFTER_ANCHOR, GIT_COMMITTER_DATE: AFTER_ANCHOR },
    });

    const result = detectChurnStale(hippoRoot, repoDir, { tenantId: 'default', projectName: project, dryRun: true });
    expect(result.preview[0]?.evidence).toBe('symbol-gone: `mergedAwaySymbol`');
  });

  it('reads tracked files from HEAD, not the index (a staged removal does not hide a change)', () => {
    fs.writeFileSync(path.join(repoDir, 'r.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    storeMemory('see r.ts for the setup', { created: ANCHOR });
    fs.writeFileSync(path.join(repoDir, 'r.ts'), 'v2');
    commit(repoDir, AFTER_ANCHOR);
    execFileSync('git', ['rm', '-q', '--cached', 'r.ts'], { cwd: repoDir });

    const result = detectChurnStale(hippoRoot, repoDir, { tenantId: 'default', projectName: project, dryRun: true });
    expect(result.preview[0]?.evidence).toBe('file-changed: r.ts');
  });

  it('script-gone fires when package.json itself was deleted after the anchor', () => {
    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ scripts: { goner: 'echo hi' } }));
    fs.writeFileSync(path.join(repoDir, 'keep.txt'), 'x');
    commit(repoDir, BEFORE_ANCHOR);
    storeMemory('run `npm run goner` to build', { created: ANCHOR });
    fs.rmSync(path.join(repoDir, 'package.json'));
    commit(repoDir, AFTER_ANCHOR);

    const result = detectChurnStale(hippoRoot, repoDir, { tenantId: 'default', projectName: project, dryRun: true });
    expect(result.preview[0]?.evidence).toBe('script-gone: goner');
  });
});

// ---------------------------------------------------------------------------
// api.outcome(): a good outcome clears the churn-stale tag
// ---------------------------------------------------------------------------

describe('api.outcome clears churn-stale on a good outcome', () => {
  let hippoRoot: string;

  beforeEach(() => {
    hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-churn-outcome-'));
    initStore(hippoRoot);
  });

  afterEach(() => {
    fs.rmSync(hippoRoot, { recursive: true, force: true });
  });

  it('drops the churn-stale tag on good=true', () => {
    const mem = createMemory('some tagged content', { tags: [CHURN_STALE_TAG] });
    writeEntry(hippoRoot, mem);

    const ctx: api.Context = { hippoRoot, tenantId: 'default', actor: api.adminActor('test') };
    api.outcome(ctx, [mem.id], true);

    expect(readEntry(hippoRoot, mem.id)!.tags).not.toContain(CHURN_STALE_TAG);
  });

  it('keeps the churn-stale tag on good=false', () => {
    const mem = createMemory('some tagged content', { tags: [CHURN_STALE_TAG] });
    writeEntry(hippoRoot, mem);

    const ctx: api.Context = { hippoRoot, tenantId: 'default', actor: api.adminActor('test') };
    api.outcome(ctx, [mem.id], false);

    expect(readEntry(hippoRoot, mem.id)!.tags).toContain(CHURN_STALE_TAG);
  });

  it('a good outcome on an untagged memory is a no-op for tags', () => {
    const mem = createMemory('plain content', { tags: ['other'] });
    writeEntry(hippoRoot, mem);

    const ctx: api.Context = { hippoRoot, tenantId: 'default', actor: api.adminActor('test') };
    api.outcome(ctx, [mem.id], true);

    expect(readEntry(hippoRoot, mem.id)!.tags).toEqual(['other']);
  });
});

// ---------------------------------------------------------------------------
// search.ts: CHURN_STALE_RANK_MULTIPLIER applied in both scoring paths
// ---------------------------------------------------------------------------

describe('CHURN_STALE_RANK_MULTIPLIER in search scoring', () => {
  it('halves the sync search() score for a churn-stale entry vs an otherwise-identical one', () => {
    const plain = createMemory('widget factory configuration details here', { tags: ['sometag'] });
    const stale = createMemory('widget factory configuration details here', { tags: ['sometag', CHURN_STALE_TAG] });

    const results = search('widget factory configuration', [plain, stale]);
    const plainResult = results.find((r) => r.entry.id === plain.id)!;
    const staleResult = results.find((r) => r.entry.id === stale.id)!;
    expect(staleResult.score).toBeLessThan(plainResult.score * 0.6);
  });

  it('applies CHURN_STALE_RANK_MULTIPLIER in the hybrid explain breakdown', async () => {
    const stale = createMemory('gadget assembly line documentation notes', { tags: [CHURN_STALE_TAG] });
    const [result] = await hybridSearch('gadget assembly line', [stale], { explain: true });
    expect(result.breakdown!.churnStaleMultiplier).toBe(CHURN_STALE_RANK_MULTIPLIER);
  });

  it('ranks a churn-stale entry below an identical untagged one in hybridSearch', async () => {
    const plain = createMemory('sprocket calibration procedure notes', { tags: [] });
    const stale = createMemory('sprocket calibration procedure notes', { tags: [CHURN_STALE_TAG] });
    const results = await hybridSearch('sprocket calibration', [stale, plain]);
    expect(results.map((r) => r.entry.id)).toEqual([plain.id, stale.id]);
  });

  it('ranks a churn-stale entry below an identical untagged one in physicsSearch', async () => {
    const hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-churn-physics-'));
    try {
      initStore(hippoRoot);
      const plain = createMemory('flywheel torque limits', { tags: [] });
      const stale = createMemory('flywheel torque limits', { tags: [CHURN_STALE_TAG] });
      writeEntry(hippoRoot, plain);
      writeEntry(hippoRoot, stale);
      const particle = (id: string): PhysicsParticle => ({
        memoryId: id, position: [1, 0, 0, 0], velocity: [0, 0, 0, 0], mass: 1.0, charge: 0,
        temperature: 0.5, lastSimulation: new Date().toISOString(),
      });
      const db = openHippoDb(hippoRoot);
      try {
        savePhysicsState(db, [particle(plain.id), particle(stale.id)]);
      } finally {
        db.close();
      }
      const results = await physicsSearch('flywheel torque', [stale, plain], {
        hippoRoot, queryEmbedding: [1, 0, 0, 0], explain: true,
      });
      expect(results.map((r) => r.entry.id)).toEqual([plain.id, stale.id]);
      expect(results[1].breakdown!.churnStaleMultiplier).toBe(CHURN_STALE_RANK_MULTIPLIER);
    } finally {
      fs.rmSync(hippoRoot, { recursive: true, force: true });
    }
  });

  it('keeps the penalty when a churn-stale hit is alone in the physics pool (pool normalisation)', async () => {
    const hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-churn-pool-'));
    try {
      initStore(hippoRoot);
      const plain = createMemory('flywheel torque limits', { tags: [] });
      const stale = createMemory('flywheel torque limits', { tags: [CHURN_STALE_TAG] });
      writeEntry(hippoRoot, plain);
      writeEntry(hippoRoot, stale);
      const db = openHippoDb(hippoRoot);
      try {
        savePhysicsState(db, [{
          memoryId: stale.id, position: [1, 0, 0, 0], velocity: [0, 0, 0, 0], mass: 1.0, charge: 0,
          temperature: 0.5, lastSimulation: new Date().toISOString(),
        }]);
      } finally {
        db.close();
      }
      const results = await physicsSearch('flywheel torque', [stale, plain], { hippoRoot, queryEmbedding: [1, 0, 0, 0] });
      const staleScore = results.find((r) => r.entry.id === stale.id)!.score;
      expect(staleScore).toBeCloseTo(CHURN_STALE_RANK_MULTIPLIER, 5);
      expect(results[0].entry.id).toBe(plain.id);
    } finally {
      fs.rmSync(hippoRoot, { recursive: true, force: true });
    }
  });

  it('penalises a churn-stale child injected by DAG drill-down (sync and hybrid)', async () => {
    const parent = createMemory('quasar ledger overview', { tags: ['dag-summary'] });
    const child = createMemory('unrelated detail text', { tags: [CHURN_STALE_TAG] });
    child.dag_parent_id = parent.id;
    for (const results of [search('quasar ledger', [parent, child]), await hybridSearch('quasar ledger', [parent, child])]) {
      const p = results.find((r) => r.entry.id === parent.id)!;
      const c = results.find((r) => r.entry.id === child.id)!;
      expect(c.score).toBeCloseTo(p.score * 0.9 * CHURN_STALE_RANK_MULTIPLIER, 6);
    }
  });

  it('sinks a churn-stale row in the default api.recall path (no search scorer)', () => {
    const hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-churn-recall-'));
    try {
      initStore(hippoRoot);
      const stale = createMemory('zephyr zephyr zephyr gearbox', { tags: [CHURN_STALE_TAG] });
      const b = createMemory('zephyr gearbox notes with a few more words', { tags: [] });
      const c = createMemory('zephyr gearbox notes with many many more padding words here', { tags: [] });
      for (const m of [stale, b, c]) writeEntry(hippoRoot, m);
      const ctx: api.Context = { hippoRoot, tenantId: 'default', actor: api.adminActor('test') };
      const ids = api.recall(ctx, { query: 'zephyr' }).results.map((r) => r.id);
      expect(ids).toHaveLength(3);
      expect(ids[0]).not.toBe(stale.id);
    } finally {
      fs.rmSync(hippoRoot, { recursive: true, force: true });
    }
  });

  it('records churnStaleMultiplier as 1.0 for a non-tagged entry', async () => {
    const plain = createMemory('gadget assembly line documentation notes', { tags: [] });
    const [result] = await hybridSearch('gadget assembly line', [plain], { explain: true });
    expect(result.breakdown!.churnStaleMultiplier).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// config.ts: churnStaleness validation
// ---------------------------------------------------------------------------

describe('config.churnStaleness', () => {
  let hippoRoot: string;

  beforeEach(() => {
    hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-churn-config-'));
    initStore(hippoRoot);
  });

  afterEach(() => {
    fs.rmSync(hippoRoot, { recursive: true, force: true });
  });

  it('defaults to disabled', () => {
    expect(loadConfig(hippoRoot).churnStaleness.enabled).toBe(false);
  });

  it('honors an explicit true', () => {
    fs.writeFileSync(path.join(hippoRoot, 'config.json'), JSON.stringify({ churnStaleness: { enabled: true } }));
    expect(loadConfig(hippoRoot).churnStaleness.enabled).toBe(true);
  });

  it('falls back to false and warns on a non-object churnStaleness', () => {
    fs.writeFileSync(path.join(hippoRoot, 'config.json'), JSON.stringify({ churnStaleness: 'yes' }));
    const errors: string[] = [];
    const orig = console.error;
    console.error = (msg: string) => errors.push(msg);
    try {
      expect(loadConfig(hippoRoot).churnStaleness.enabled).toBe(false);
    } finally {
      console.error = orig;
    }
    expect(errors.some((e) => e.includes('"churnStaleness"'))).toBe(true);
  });

  it('falls back to false and warns on a non-boolean enabled', () => {
    fs.writeFileSync(path.join(hippoRoot, 'config.json'), JSON.stringify({ churnStaleness: { enabled: 'yes' } }));
    const errors: string[] = [];
    const orig = console.error;
    console.error = (msg: string) => errors.push(msg);
    try {
      expect(loadConfig(hippoRoot).churnStaleness.enabled).toBe(false);
    } finally {
      console.error = orig;
    }
    expect(errors.some((e) => e.includes('"churnStaleness.enabled"'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CLI wiring: `hippo invalidate --churn` and `hippo sleep`
// ---------------------------------------------------------------------------

const CLI = path.resolve(__dirname, '..', 'bin', 'hippo.js');

function runCli(cwd: string, args: string[], env: NodeJS.ProcessEnv, opts: { ok?: boolean } = {}) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8', env });
    return { stdout, stderr: '' };
  } catch (err) {
    // SAFETY: execFileSync attaches stdout/stderr/status to the thrown Error on a non-zero child exit.
    const e = err as { stdout?: string; stderr?: string; status?: number };
    if (opts.ok === false) return { stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    throw new Error(`CLI exit ${e.status}: ${e.stderr ?? ''}\nstdout: ${e.stdout ?? ''}`);
  }
}

describe('hippo invalidate --churn (CLI)', () => {
  let repoDir: string;
  let globalRoot: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-churn-cli-repo-'));
    globalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-churn-cli-global-'));
    initGitRepo(repoDir);
    fs.writeFileSync(path.join(repoDir, 'k.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    env = { ...process.env, HIPPO_HOME: globalRoot, HIPPO_SKIP_AUTO_INTEGRATIONS: '1' };
    execFileSync('node', [CLI, 'init', '--no-hooks', '--no-schedule', '--no-learn'], { cwd: repoDir, env });
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(globalRoot, { recursive: true, force: true });
  });

  it('rejects --churn combined with a pattern', () => {
    const { stderr } = runCli(repoDir, ['invalidate', 'somepattern', '--churn'], env, { ok: false });
    expect(stderr).toContain('Usage: hippo invalidate --churn');
  });

  it('rejects --churn combined with --id', () => {
    const { stderr } = runCli(repoDir, ['invalidate', '--churn', '--id', 'mem_x'], env, { ok: false });
    expect(stderr).toContain('Usage: hippo invalidate --churn');
  });

  it('dry-run previews the tag without writing, then a live run tags it', () => {
    const hippoRoot = path.join(repoDir, '.hippo');
    const mem = createMemory('see k.ts for the setup', { tags: [] });
    mem.created = ANCHOR;
    mem.origin_project = path.basename(repoDir).toLowerCase();
    writeEntry(hippoRoot, mem);
    fs.writeFileSync(path.join(repoDir, 'k.ts'), 'v2');
    commit(repoDir, AFTER_ANCHOR);

    const dry = runCli(repoDir, ['invalidate', '--churn', '--dry-run'], env);
    expect(dry.stdout).toContain('WOULD be tagged');
    expect(dry.stdout).toContain(mem.id);
    expect(readEntry(hippoRoot, mem.id)!.tags).not.toContain(CHURN_STALE_TAG);

    const live = runCli(repoDir, ['invalidate', '--churn'], env);
    expect(live.stdout).toContain('Tagged 1 memories');
    expect(readEntry(hippoRoot, mem.id)!.tags).toContain(CHURN_STALE_TAG);
  });

  it('also tags this repo\'s memories in the global store', () => {
    initStore(globalRoot);
    const mem = createMemory('see k.ts for the setup', { tags: [] });
    mem.created = ANCHOR;
    mem.origin_project = path.basename(repoDir).toLowerCase();
    writeEntry(globalRoot, mem);
    fs.writeFileSync(path.join(repoDir, 'k.ts'), 'v2');
    commit(repoDir, AFTER_ANCHOR);

    runCli(repoDir, ['invalidate', '--churn'], env);
    expect(readEntry(globalRoot, mem.id)!.tags).toContain(CHURN_STALE_TAG);
  });

  it('exits non-zero when the git read fails', () => {
    const mem = createMemory('see k.ts for the setup', { tags: [] });
    mem.created = ANCHOR;
    mem.origin_project = path.basename(repoDir).toLowerCase();
    writeEntry(path.join(repoDir, '.hippo'), mem);
    execFileSync('git', ['update-ref', '-d', 'HEAD'], { cwd: repoDir });

    const { stderr } = runCli(repoDir, ['invalidate', '--churn'], env, { ok: false });
    expect(stderr).toContain('Churn-staleness check failed');
  });
});

describe('hippo sleep + config.churnStaleness.enabled (CLI)', () => {
  let repoDir: string;
  let globalRoot: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-churn-sleep-repo-'));
    globalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-churn-sleep-global-'));
    initGitRepo(repoDir);
    fs.writeFileSync(path.join(repoDir, 'm.ts'), 'v1');
    commit(repoDir, BEFORE_ANCHOR);
    env = { ...process.env, HIPPO_HOME: globalRoot, HIPPO_SKIP_AUTO_INTEGRATIONS: '1' };
    execFileSync('node', [CLI, 'init', '--no-hooks', '--no-schedule', '--no-learn'], { cwd: repoDir, env });
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(globalRoot, { recursive: true, force: true });
  });

  function setupChurnMemory(hippoRoot: string): string {
    const mem = createMemory('see m.ts for the setup', { tags: [] });
    mem.created = ANCHOR;
    mem.origin_project = path.basename(repoDir).toLowerCase();
    writeEntry(hippoRoot, mem);
    fs.writeFileSync(path.join(repoDir, 'm.ts'), 'v2');
    commit(repoDir, AFTER_ANCHOR);
    return mem.id;
  }

  it('does not tag anything on sleep when churnStaleness.enabled is false (default)', () => {
    const hippoRoot = path.join(repoDir, '.hippo');
    const memId = setupChurnMemory(hippoRoot);

    // Plain `sleep` (no --no-learn) so Phase 1 runs and only the config gate stops the tagging.
    const { stdout } = runCli(repoDir, ['sleep'], env);
    expect(stdout).not.toContain('churn-stale');
    expect(readEntry(hippoRoot, memId)!.tags).not.toContain(CHURN_STALE_TAG);
  });

  it('tags on sleep when churnStaleness.enabled is true', () => {
    const hippoRoot = path.join(repoDir, '.hippo');
    fs.writeFileSync(path.join(hippoRoot, 'config.json'), JSON.stringify({ churnStaleness: { enabled: true } }));
    const memId = setupChurnMemory(hippoRoot);

    const { stdout } = runCli(repoDir, ['sleep'], env);
    expect(stdout).toContain('Tagged 1 memories churn-stale');
    expect(readEntry(hippoRoot, memId)!.tags).toContain(CHURN_STALE_TAG);
  });
});
