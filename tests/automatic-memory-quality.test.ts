import { describe, expect, it } from 'vitest';
import { assessAutomaticMemory } from '../src/automatic-memory-quality.js';
import { auditMemory, isContentWorthStoring } from '../src/audit.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';

describe('automatic assertion quality', () => {
  it.each([
    ['Found local migration files to be', 'sentence-fragment'],
    ['The store requires the migration to', 'sentence-fragment'],
    ['Retry the API request because', 'sentence-fragment'],
    ['The cache refresh depends on', 'sentence-fragment'],
    ['Deploy the API only if the', 'sentence-fragment'],
    ['when the API succeeds', 'sentence-fragment'],
    ['succeeds (inserts or updates)', 'subjectless-outcome'],
    ['returned 3 matching rows', 'subjectless-outcome'],
    ['TypeError: Cannot read properties of undefined', 'raw-output'],
    ["Command 'npm test' failed (exit 1): test suite failed", 'raw-output'],
    ['stdout: inserted 3 records', 'raw-output'],
    ['{"success":true,"rows":3}', 'raw-output'],
    ['bump build 78 for codemagic deploy', 'release-activity'],
    ['increment iOS build number to 79', 'release-activity'],
    ['deployed build 78 to Codemagic', 'release-activity'],
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
    'Codemagic deployment requires a build number greater than the previous upload',
    'Always bump the iOS build number before uploading through Codemagic',
    'Never use `--no-verify` because it skips the commit checks',
  ])('retains supported memory: %s', (content) => {
    expect(assessAutomaticMemory(content)).toEqual({ accepted: true, reason: null });
  });

  it('new defect reasons warn without widening automatic audit removal', () => {
    const entry = (content: string) => createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    expect(auditMemory(entry('Found local migration files to be'))?.severity).toBe('warning');
    expect(auditMemory(entry('bump build 78 for codemagic deploy'))?.severity).toBe('warning');
    expect(auditMemory(entry('succeeds (inserts or updates)'))?.severity).toBe('warning');
    expect(auditMemory(entry('bump 1.63.1'))?.severity).toBe('error');
    expect(auditMemory(entry('fix'))?.severity).toBe('error');
  });
});
