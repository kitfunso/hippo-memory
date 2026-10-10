import { describe, expect, it } from 'vitest';
import { assessAutomaticMemory, certainDefect, isAutomaticEntry, isContentWorthStoring, isReusable, isWorthSurfacing } from '../src/core/memory-quality.js';
import { auditMemory } from '../src/store/audit.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, type CreateMemoryOptions } from '../src/core/memory.js';
import { mergedText } from '../src/util/same-text.js';

const make = (content: string, options: Partial<CreateMemoryOptions> = {}) => createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, ...options });
const captured = (content: string) => make(content, { source: 'capture', confidence: 'observed' });

describe('automatic assertion quality', () => {
  it.each([
    ['Found local migration files to be', 'sentence-fragment'],
    ['Retry the API request because', 'sentence-fragment'],
    ['Deploy the API only if the', 'sentence-fragment'],
    ['when the API succeeds', 'sentence-fragment'],
    ['when CI fails we retry once', 'sentence-fragment'],
    ['to rebuild the index', 'sentence-fragment'],
    ['and the cache is cold', 'sentence-fragment'],
    ['for the deploy script', 'sentence-fragment'],
    ['succeeds (inserts or updates)', 'subjectless-outcome'],
    ['returned 3 matching rows', 'subjectless-outcome'],
    ['TypeError: Cannot read properties of undefined', 'raw-output'],
    ["Command 'npm test' failed (exit 1): test suite failed", 'raw-output'],
    ['stdout: inserted 3 records', 'raw-output'],
    ['{"success":true,"rows":3}', 'raw-output'],
    ['[1, 2, 3, 4, 5]', 'raw-output'],
    ['2026-10-05 10:00:01 INFO server started on port 8080', 'raw-output'],
    ['[info] server listening on port 8080', 'raw-output'],
    ['2026-10-05 10:00:01 WARN retrying after 503 from upstream', 'raw-output'],
    ['[error] connection reset while reading body', 'raw-output'],
    ['2026-10-05 10:00:01 ERROR: upstream refused the call because the token expired', 'raw-output'],
    ['bump build 78 for testflight deploy', 'release-activity'],
    ['increment iOS build number to 79', 'release-activity'],
    ['deployed build 78 to TestFlight', 'release-activity'],
    ['release v1.63.1', 'release-activity'],
  ] as const)('rejects %s with an actionable reason', (content, reason) => {
    expect(assessAutomaticMemory(content)).toEqual({ accepted: false, reason });
    expect(isContentWorthStoring(content)).toBe(false);
  });

  it.each([
    'The store requires the migration to',
    'The cache refresh depends on',
    'Deploys wait for the migration this release depends on.',
    'If the build fails',
    'When CI fails we retry once',
  ])('stores a possible fragment and names it for review: %s', (content) => {
    expect(assessAutomaticMemory(content)).toEqual({ accepted: true, reason: 'possible-fragment' });
    expect(certainDefect(content)).toBeNull();
  });

  it.each([
    'Prefer pnpm',
    'prefer pnpm over npm',
    'Use SQLite for the offline cache',
    '数据库迁移必须保留用户数据',
    'The API succeeds when inserts or updates complete',
    'If the API fails, retry after the Retry-After delay',
    'The migration failed because test setup was placed in production migrations; move setup to the test directory',
    'bump pool timeout to 30s in src/db/index.ts',
    'TestFlight deployment requires a build number greater than the previous upload',
    'Always bump the iOS build number before uploading through TestFlight',
    'Never use `--no-verify` because it skips the commit checks',
    'Returns 404 when the API key is missing from the header',
    'When CI is red rerun the failed jobs before touching code',
    '[deploy] note: wrangler deploys the site, git push does not',
    'Updated the publish workflow so prepublishOnly runs the full suite',
    'Always run the linter before you push to master',
    'Error: the migration silently dropped the last batch of rows.',
    'Deleted rows must never be resurrected by the sync job',
    'Failed jobs are retried eight times with a ten minute gap',
    'Returns 404 for unknown ids',
    'Use option B rather than option A',
    'if in doubt never force-push',
    'If in doubt never force-push',
    'When unsure always ask first',
    'Set version to 2.0 in both package.json and Cargo.toml, never just one',
    'Deploy v1.2 only after the migration has run on the VM',
    '[2026-09-30] decided to keep the VM fork on 1.58',
    'To rebuild the index, run hippo rebuild --force',
    'For the deploy script, always pass the region flag',
    '2026-10-05 10:00 freeze starts, never merge to main',
    'TypeError: x is undefined when the cache is cold, so warm it first',
    '[info] never deploy on Fridays',
    '{ retries: 3 } is the default retry policy',
    '[1, 2, 3] are the allowed retry counts',
  ])('retains supported memory: %s', (content) => {
    expect(assessAutomaticMemory(content)).toEqual({ accepted: true, reason: null });
  });

  it('only flags an ending that can close a whole sentence', () => {
    expect(certainDefect('The store requires the migration to')).toBeNull();
    expect(certainDefect('Retry the API request because')).toBe('sentence-fragment');
  });
});

describe('automatic provenance', () => {
  it('recognises each automatic writer on its own', () => {
    const base = make('Never push from the VM', { source: 'cli', confidence: 'observed' });
    expect(isAutomaticEntry(base)).toBe(false);
    for (const source of ['capture', 'git-learn', 'git', 'consolidation', 'compaction:session-1']) {
      expect(isAutomaticEntry({ ...base, source }), source).toBe(true);
    }
    for (const tag of ['captured', 'compaction-memory', 'git-learned']) {
      for (const source of ['promoted:/work/app/.hippo', 'shared:app:2026-10-05T10:00:00.000Z']) {
        expect(isAutomaticEntry({ ...base, source, tags: [tag] }), `${source} ${tag}`).toBe(true);
      }
    }
    expect(isAutomaticEntry({ ...base, extracted_from: 'm_1' })).toBe(true);
    expect(isAutomaticEntry({ ...base, dag_level: 1 })).toBe(true);
    expect(isAutomaticEntry({ ...base, content: '[Consolidated from 2 related memories]\n\nNever push from the VM' })).toBe(true);
  });

  it('leaves watch failures, tool failures and vouched rows to the person floor', () => {
    const base = make('Never push from the VM');
    expect(isAutomaticEntry({ ...base, source: 'autolearn', confidence: 'observed' })).toBe(false);
    expect(isAutomaticEntry({ ...base, source: 'tool-failure', confidence: 'observed' })).toBe(false);
    for (const confidence of ['verified', 'stale'] as const) {
      expect(isAutomaticEntry({ ...base, source: 'capture', confidence }), confidence).toBe(false);
    }
  });

  it('reads a writer tag as provenance only on a promoted or shared copy', () => {
    // A "## Captured" heading in an imported MEMORY.md becomes the tag "captured" on a person's note.
    for (const source of ['import:markdown', 'cli', 'mcp']) {
      expect(isAutomaticEntry(make('Found local migration files to be', { source, confidence: 'observed', tags: ['imported', 'captured'] })), source).toBe(false);
    }
  });

  it('reuses a person row whatever its text and an automatic row only without a certain defect', () => {
    expect(isReusable(make('Found local migration files to be'))).toBe(true);
    expect(isReusable(captured('Found local migration files to be'))).toBe(false);
    expect(isReusable(captured('The store requires the migration to'))).toBe(true);
  });

  it('surfaces a person row the automatic check would refuse', () => {
    expect(isWorthSurfacing(make('Found local migration files to be'))).toBe(true);
    expect(isWorthSurfacing(captured('Found local migration files to be'))).toBe(false);
  });

  it('judges a bundle by its parts, so only a bundle of nothing but certain defects is held back', () => {
    const bundle = (parts: string[]) => make(mergedText('[Consolidated from 2 related memories, newest first]', parts), { source: 'consolidation', confidence: 'observed' });
    const lastPartCut = bundle(['Never push from the VM to main', 'Rebase the feature branch onto main before you merge, because']);
    expect(isReusable(lastPartCut)).toBe(true);
    expect(isWorthSurfacing(lastPartCut)).toBe(true);
    const allCut = bundle(['Found local migration files to be', 'Retry the API request because']);
    expect(isReusable(allCut)).toBe(false);
    expect(isWorthSurfacing(allCut)).toBe(false);
    expect(auditMemory(lastPartCut)).toBeNull();
    expect(auditMemory(allCut)?.severity).toBe('warning');
  });

  it('audit warns about automatic defects on automatic rows only', () => {
    expect(auditMemory(captured('Found local migration files to be'))?.severity).toBe('warning');
    expect(auditMemory(captured('bump build 78 for testflight deploy'))?.severity).toBe('warning');
    expect(auditMemory(captured('succeeds (inserts or updates)'))?.severity).toBe('warning');
    expect(auditMemory(make('Found local migration files to be'))).toBeNull();
    expect(auditMemory(make('bump 1.63.1'))?.severity).toBe('error');
    expect(auditMemory(make('fix'))?.severity).toBe('error');
  });
});
