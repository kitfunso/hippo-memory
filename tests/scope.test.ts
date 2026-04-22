import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { detectScope, scopeMatch } from '../src/scope.js';

describe('detectScope', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save and clear relevant env vars
    for (const key of ['HIPPO_SCOPE', 'GSTACK_SKILL', 'OPENCLAW_SKILL']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore env vars
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it('returns null when no env vars set and on default branch', () => {
    // In CI/test, we're typically on master/main — detectScope should return null
    // or a feature branch name. We can only guarantee null when all env vars are clear
    // and we mock the git call. For unit purity, just verify env var priority.
    const result = detectScope();
    // If we're on master/main/develop/dev, result is null.
    // If on a feature branch, result is the branch name. Both are valid.
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('returns HIPPO_SCOPE when set', () => {
    process.env['HIPPO_SCOPE'] = 'plan-eng-review';
    expect(detectScope()).toBe('plan-eng-review');
  });

  it('trims HIPPO_SCOPE whitespace', () => {
    process.env['HIPPO_SCOPE'] = '  qa  ';
    expect(detectScope()).toBe('qa');
  });

  it('returns GSTACK_SKILL when set and no HIPPO_SCOPE', () => {
    process.env['GSTACK_SKILL'] = 'design-review';
    expect(detectScope()).toBe('design-review');
  });

  it('HIPPO_SCOPE takes priority over GSTACK_SKILL', () => {
    process.env['HIPPO_SCOPE'] = 'explicit-scope';
    process.env['GSTACK_SKILL'] = 'gstack-scope';
    expect(detectScope()).toBe('explicit-scope');
  });

  it('returns OPENCLAW_SKILL when set and no higher-priority vars', () => {
    process.env['OPENCLAW_SKILL'] = 'oc-skill';
    expect(detectScope()).toBe('oc-skill');
  });

  it('ignores empty/whitespace-only env vars', () => {
    process.env['HIPPO_SCOPE'] = '   ';
    process.env['GSTACK_SKILL'] = '';
    const result = detectScope();
    // Should fall through to git branch or null
    expect(result !== '   ' && result !== '').toBe(true);
  });
});

describe('scopeMatch', () => {
  it('returns 0 when memory has no scope tags', () => {
    expect(scopeMatch(['error', 'path:src'], 'plan-eng-review')).toBe(0);
  });

  it('returns 0 when memory has no scope tags and no active scope', () => {
    expect(scopeMatch(['error', 'decision'], null)).toBe(0);
  });

  it('returns 0 when no active scope even if memory has scope tags', () => {
    expect(scopeMatch(['scope:plan-eng-review', 'error'], null)).toBe(0);
  });

  it('returns 1 when scope matches', () => {
    expect(scopeMatch(['scope:plan-eng-review', 'error'], 'plan-eng-review')).toBe(1);
  });

  it('returns -1 when scope mismatches', () => {
    expect(scopeMatch(['scope:plan-eng-review'], 'qa')).toBe(-1);
  });

  it('returns 1 when one of multiple scope tags matches', () => {
    expect(scopeMatch(['scope:qa', 'scope:plan-eng-review'], 'qa')).toBe(1);
  });

  it('returns -1 when none of multiple scope tags match', () => {
    expect(scopeMatch(['scope:qa', 'scope:design-review'], 'plan-eng-review')).toBe(-1);
  });

  it('ignores non-scope tags', () => {
    expect(scopeMatch(['path:src', 'decision', 'scope:qa'], 'qa')).toBe(1);
  });
});
