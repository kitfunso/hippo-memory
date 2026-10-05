import { describe, expect, it } from 'vitest';
import { assessAutomaticMemory, certainDefect } from '../src/automatic-memory-quality.js';
import { auditMemory, isContentWorthStoring } from '../src/audit.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';

describe('automatic assertion quality', () => {
  it.each([
    ['Found local migration files to be', 'sentence-fragment'],
    ['The store requires the migration to', 'possible-fragment'],
    ['Retry the API request because', 'sentence-fragment'],
    ['The cache refresh depends on', 'possible-fragment'],
    ['Deploy the API only if the', 'sentence-fragment'],
    ['when the API succeeds', 'sentence-fragment'],
    ['If the build fails', 'sentence-fragment'],
    ['succeeds (inserts or updates)', 'subjectless-outcome'],
    ['returned 3 matching rows', 'subjectless-outcome'],
    ['TypeError: Cannot read properties of undefined', 'raw-output'],
    ["Command 'npm test' failed (exit 1): test suite failed", 'raw-output'],
    ['stdout: inserted 3 records', 'raw-output'],
    ['{"success":true,"rows":3}', 'raw-output'],
    ['bump build 78 for testflight deploy', 'release-activity'],
    ['increment iOS build number to 79', 'release-activity'],
    ['deployed build 78 to TestFlight', 'release-activity'],
    ['release v1.63.1', 'release-activity'],
  ] as const)('rejects %s with an actionable reason', (content, reason) => {
    expect(assessAutomaticMemory(content)).toEqual({ accepted: false, reason });
    expect(isContentWorthStoring(content)).toBe(false);
  });

  it.each([
    'Prefer pnpm',
    'prefer pnpm over npm',
    'Use SQLite for the offline cache',
    '数据库迁移必须保留用户数据',
    'The API succeeds when inserts or updates complete',
    'If the API fails, retry after the Retry-After delay',
    'The migration failed because test setup was placed in production migrations; move setup to the test directory',
    'bump pool timeout to 30s in src/db.ts',
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
  ])('retains supported memory: %s', (content) => {
    expect(assessAutomaticMemory(content)).toEqual({ accepted: true, reason: null });
  });

  it('only flags an ending that can close a whole sentence', () => {
    expect(certainDefect('The store requires the migration to')).toBeNull();
    expect(certainDefect('Retry the API request because')).toBe('sentence-fragment');
  });

  it('new defect reasons warn without widening automatic audit removal', () => {
    const entry = (content: string) => createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    expect(auditMemory(entry('Found local migration files to be'))?.severity).toBe('warning');
    expect(auditMemory(entry('bump build 78 for testflight deploy'))?.severity).toBe('warning');
    expect(auditMemory(entry('succeeds (inserts or updates)'))?.severity).toBe('warning');
    expect(auditMemory(entry('bump 1.63.1'))?.severity).toBe('error');
    expect(auditMemory(entry('fix'))?.severity).toBe('error');
  });
});
