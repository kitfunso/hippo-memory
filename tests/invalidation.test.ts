import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { extractInvalidationTarget, invalidateMatching } from '../src/invalidation.js';
import { initStore, writeEntry, readEntry } from '../src/store.js';
import { createMemory } from '../src/memory.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('extractInvalidationTarget', () => {
  it('extracts "from" target in "migrate X to Y"', () => {
    const result = extractInvalidationTarget('feat: migrate from REST to GraphQL');
    expect(result).toEqual({ from: 'REST', to: 'GraphQL', type: 'migration' });
  });

  it('extracts "from" target in "replace X with Y"', () => {
    const result = extractInvalidationTarget('refactor: replace Moment.js with date-fns');
    expect(result).toEqual({ from: 'Moment.js', to: 'date-fns', type: 'migration' });
  });

  it('extracts target in "remove X"', () => {
    const result = extractInvalidationTarget('chore: remove legacy auth middleware');
    expect(result).toEqual({ from: 'legacy auth middleware', to: null, type: 'removal' });
  });

  it('extracts target in "drop X"', () => {
    const result = extractInvalidationTarget('breaking: drop Python 3.8 support');
    expect(result).toEqual({ from: 'Python 3.8 support', to: null, type: 'removal' });
  });

  it('extracts target in "deprecate X"', () => {
    const result = extractInvalidationTarget('chore: deprecate v1 API endpoints');
    expect(result).toEqual({ from: 'v1 API endpoints', to: null, type: 'deprecation' });
  });

  it('extracts "from X to Y" without verb prefix', () => {
    const result = extractInvalidationTarget('feat: switch from webpack to vite');
    expect(result).toEqual({ from: 'webpack', to: 'vite', type: 'migration' });
  });

  it('returns null for normal commits', () => {
    const result = extractInvalidationTarget('fix: correct off-by-one in pagination');
    expect(result).toBeNull();
  });

  it('returns null for ambiguous removals', () => {
    const result = extractInvalidationTarget('fix: remove extra whitespace');
    expect(result).toBeNull();
  });
});

describe('invalidateMatching', () => {
  let tmpDir: string;
  let hippoRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-invalidation-'));
    hippoRoot = path.join(tmpDir, '.hippo');
    initStore(hippoRoot);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('weakens memories matching the invalidation target', () => {
    const mem = createMemory('REST API endpoint /users returns paginated results', {
      tags: ['api', 'rest'],
    });
    writeEntry(hippoRoot, mem);

    const result = invalidateMatching(hippoRoot, { from: 'REST', to: 'GraphQL', type: 'migration' });

    expect(result.invalidated).toBe(1);
    const updated = readEntry(hippoRoot, mem.id);
    expect(updated!.confidence).toBe('stale');
    expect(updated!.tags).toContain('invalidated');
    expect(updated!.half_life_days).toBeLessThan(mem.half_life_days);
  });

  it('does not touch unrelated memories', () => {
    const mem = createMemory('Database connection pool max is 20', {
      tags: ['database'],
    });
    writeEntry(hippoRoot, mem);

    const result = invalidateMatching(hippoRoot, { from: 'REST', to: 'GraphQL', type: 'migration' });

    expect(result.invalidated).toBe(0);
    const updated = readEntry(hippoRoot, mem.id);
    expect(updated!.half_life_days).toBe(mem.half_life_days);
  });

  it('does not touch pinned memories', () => {
    const mem = createMemory('REST API uses OAuth2 tokens', {
      tags: ['api', 'rest'],
      pinned: true,
    });
    writeEntry(hippoRoot, mem);

    const result = invalidateMatching(hippoRoot, { from: 'REST', to: 'GraphQL', type: 'migration' });

    expect(result.invalidated).toBe(0);
  });
});

describe('invalidateMatching safety (2026-06-09 incident)', () => {
  let tmpDir: string;
  let hippoRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-inv-safety-'));
    hippoRoot = path.join(tmpDir, '.hippo');
    initStore(hippoRoot);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('BYSTANDER LOCK: a multi-token pattern containing a tag word does not invalidate that tag', () => {
    // The incident shape: pattern tokens include "hippo"; bystander is tagged
    // exactly `hippo` but its CONTENT overlaps < 0.5 with the pattern. On the
    // pre-fix code (token-level tagMatch) this fired; it must not now.
    const bystander = createMemory('Weekly grocery budget tracking notes', {
      tags: ['hippo'],
    });
    writeEntry(hippoRoot, bystander);

    const result = invalidateMatching(hippoRoot, {
      from: 'hippo salience gate experiment',
      to: null,
      type: 'removal',
    });

    expect(result.invalidated).toBe(0);
    expect(result.targets).not.toContain(bystander.id);
    const updated = readEntry(hippoRoot, bystander.id);
    expect(updated!.confidence).toBe(bystander.confidence);
    expect(updated!.tags).not.toContain('invalidated');
    expect(updated!.half_life_days).toBe(bystander.half_life_days);
  });

  it('secondary: hyphenated sibling tags are also untouched', () => {
    const sibling = createMemory('Roadmap planning for next quarter cycles', {
      tags: ['hippo-roadmap'],
    });
    writeEntry(hippoRoot, sibling);

    const result = invalidateMatching(hippoRoot, {
      from: 'hippo salience gate experiment',
      to: null,
      type: 'removal',
    });

    expect(result.invalidated).toBe(0);
    expect(readEntry(hippoRoot, sibling.id)!.tags).not.toContain('invalidated');
  });

  it('exact full-pattern tag match still fires', () => {
    const mem = createMemory('Quarterly roadmap priorities for the project', {
      tags: ['hippo-roadmap'],
    });
    writeEntry(hippoRoot, mem);

    const result = invalidateMatching(hippoRoot, {
      from: 'hippo-roadmap',
      to: null,
      type: 'deprecation',
    });

    expect(result.invalidated).toBe(1);
    expect(readEntry(hippoRoot, mem.id)!.confidence).toBe('stale');
  });

  it('content matching (>=0.5 overlap) is unchanged regardless of tags', () => {
    const mem = createMemory('REST API endpoint returns paginated results', {
      tags: ['unrelated-tag'],
    });
    writeEntry(hippoRoot, mem);

    const result = invalidateMatching(hippoRoot, {
      from: 'REST API',
      to: 'GraphQL',
      type: 'migration',
    });

    expect(result.invalidated).toBe(1);
  });

  it('dryRun evaluates matches but writes nothing', () => {
    const mem = createMemory('REST API uses Bearer tokens everywhere', {
      tags: ['api'],
    });
    writeEntry(hippoRoot, mem);

    const result = invalidateMatching(
      hippoRoot,
      { from: 'REST API', to: 'GraphQL', type: 'migration' },
      undefined,
      { dryRun: true },
    );

    expect(result.dryRun).toBe(true);
    expect(result.invalidated).toBe(1); // would-be count
    expect(result.targets).toContain(mem.id);
    expect(result.preview.length).toBe(1);
    expect(result.preview[0].id).toBe(mem.id);
    const untouched = readEntry(hippoRoot, mem.id);
    expect(untouched!.confidence).toBe(mem.confidence);
    expect(untouched!.half_life_days).toBe(mem.half_life_days);
    expect(untouched!.tags).not.toContain('invalidated');
  });

  it('onlyId invalidates exactly that memory and nothing else', () => {
    const targetMem = createMemory('Completely unrelated content about gardening', {
      tags: ['garden'],
    });
    const other = createMemory('Another unrelated memory about cooking', {
      tags: ['cooking'],
    });
    writeEntry(hippoRoot, targetMem);
    writeEntry(hippoRoot, other);

    const result = invalidateMatching(
      hippoRoot,
      { from: `id:${targetMem.id}`, to: 'manual correction', type: 'migration' },
      undefined,
      { onlyId: targetMem.id },
    );

    expect(result.invalidated).toBe(1);
    expect(result.targets).toEqual([targetMem.id]);
    expect(readEntry(hippoRoot, targetMem.id)!.confidence).toBe('stale');
    expect(readEntry(hippoRoot, other.id)!.confidence).toBe(other.confidence);
  });

  it('onlyId with an unknown id invalidates nothing', () => {
    const mem = createMemory('Some memory content here', { tags: ['x'] });
    writeEntry(hippoRoot, mem);

    const result = invalidateMatching(
      hippoRoot,
      { from: 'id:mem_doesnotexist0000', to: null, type: 'removal' },
      undefined,
      { onlyId: 'mem_doesnotexist0000' },
    );

    expect(result.invalidated).toBe(0);
    expect(result.targets).toEqual([]);
  });

  it('onlyId on a pinned memory is skipped and reported', () => {
    const mem = createMemory('Pinned canonical fact', { tags: ['law'], pinned: true });
    writeEntry(hippoRoot, mem);

    const result = invalidateMatching(
      hippoRoot,
      { from: `id:${mem.id}`, to: null, type: 'removal' },
      undefined,
      { onlyId: mem.id },
    );

    expect(result.invalidated).toBe(0);
    expect(result.skippedPinned).toEqual([mem.id]);
    expect(readEntry(hippoRoot, mem.id)!.confidence).toBe(mem.confidence);
  });

  it('pattern-mode pinned matches are reported in skippedPinned', () => {
    const mem = createMemory('REST API canonical contract', { tags: ['api'], pinned: true });
    writeEntry(hippoRoot, mem);

    const result = invalidateMatching(hippoRoot, {
      from: 'REST API',
      to: 'GraphQL',
      type: 'migration',
    });

    expect(result.invalidated).toBe(0);
    expect(result.skippedPinned).toEqual([mem.id]);
  });
});
