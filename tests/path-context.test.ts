import { describe, it, expect } from 'vitest';
import { extractPathTags, pathOverlapScore, pathBoostMultiplier, PATH_BOOST_WEIGHT } from '../src/path-context.js';

describe('extractPathTags', () => {
  it('extracts meaningful segments from Unix path', () => {
    const tags = extractPathTags('/home/user/projects/my-app/src/api');
    expect(tags).toContain('path:projects');
    expect(tags).toContain('path:my-app');
    expect(tags).toContain('path:src');
    expect(tags).toContain('path:api');
    expect(tags).not.toContain('path:home');
    expect(tags).not.toContain('path:user');
  });

  it('extracts meaningful segments from Windows path', () => {
    const tags = extractPathTags('C:\\Users\\dev\\projects\\hippo\\src');
    expect(tags).toContain('path:projects');
    expect(tags).toContain('path:hippo');
    expect(tags).toContain('path:src');
    expect(tags).not.toContain('path:users');
    expect(tags).not.toContain('path:c:');
  });

  it('filters noise directories', () => {
    const tags = extractPathTags('/home/user/node_modules/.git/dist');
    expect(tags).not.toContain('path:node_modules');
    expect(tags).not.toContain('path:.git');
    expect(tags).not.toContain('path:dist');
  });

  it('keeps last 4 meaningful segments', () => {
    const tags = extractPathTags('/aa/bb/cc/dd/ee/ff/gg/hh');
    expect(tags).toHaveLength(4);
    expect(tags).toContain('path:ee');
    expect(tags).toContain('path:ff');
    expect(tags).toContain('path:gg');
    expect(tags).toContain('path:hh');
  });

  it('returns empty for root or trivial paths', () => {
    const tags = extractPathTags('/');
    expect(tags).toHaveLength(0);
  });
});

describe('pathOverlapScore', () => {
  it('returns 1.0 for exact match', () => {
    const tags = ['path:src', 'path:api'];
    expect(pathOverlapScore(tags, tags)).toBe(1.0);
  });

  it('returns partial score for partial match', () => {
    const memTags = ['path:my-app', 'path:src', 'path:api'];
    const curTags = ['path:my-app', 'path:src', 'path:tests'];
    const score = pathOverlapScore(memTags, curTags);
    expect(score).toBeCloseTo(2/3);
  });

  it('returns 0 for no match', () => {
    const memTags = ['path:frontend', 'path:components'];
    const curTags = ['path:backend', 'path:api'];
    expect(pathOverlapScore(memTags, curTags)).toBe(0);
  });

  it('returns 0 when either has no path tags', () => {
    expect(pathOverlapScore([], ['path:src'])).toBe(0);
    expect(pathOverlapScore(['path:src'], [])).toBe(0);
  });

  // C2 contract: normalize by the more specific (larger) side. A single
  // memory tag matching one of three current-path tags scores 1/3, not 1/1
  // (the old memory-count normalization would have scored this 1.0).
  it('normalizes by the more specific side (C2 contract)', () => {
    const score = pathOverlapScore(['path:g'], ['path:g', 'path:a', 'path:b']);
    expect(score).toBeCloseTo(1 / 3, 10);
  });
});

describe('pathBoostMultiplier', () => {
  it('returns 1.0 when memory has no path tags', () => {
    expect(pathBoostMultiplier(['decision', 'other-tag'], ['path:src', 'path:api'])).toBe(1.0);
  });

  it('returns 1.0 when currentPathTags is empty', () => {
    expect(pathBoostMultiplier(['path:src', 'path:api'], [])).toBe(1.0);
  });

  it('ignores non-path tags mixed in when computing overlap', () => {
    // Naive implementations that don't filter memoryTags before dividing would
    // use length 2 (score 0.5, boost 1.15) instead of the filtered length 1.
    const boost = pathBoostMultiplier(['note', 'path:src'], ['path:src']);
    expect(boost).toBe(1.3);
  });

  it('returns 1.3 for exact match (1 + 1.0 * PATH_BOOST_WEIGHT)', () => {
    const tags = ['path:src', 'path:api'];
    expect(pathBoostMultiplier(tags, tags)).toBeCloseTo(1 + 1.0 * PATH_BOOST_WEIGHT);
    expect(pathBoostMultiplier(tags, tags)).toBe(1.3);
  });

  // DEFECT PIN: fixed by the C2 max-normalization (was 1.3x under the old
  // memory-count normalization); see
  // docs/plans/2026-07-18-s5-path-overlap-tuning.md T3
  it('DEFECT PIN: a single generic path tag no longer scores the full 1.3x boost from a deeper cwd', () => {
    const boost = pathBoostMultiplier(
      ['path:skf-user'],
      ['path:skf-user', 'path:proj-nova', 'path:lib'],
    );
    expect(boost).toBeCloseTo(1.1, 10);
  });

  it('returns 1.15 for partial match (2 of 4 memory tags match)', () => {
    const boost = pathBoostMultiplier(
      ['path:a', 'path:b', 'path:c', 'path:d'],
      ['path:a', 'path:b', 'path:x', 'path:y'],
    );
    expect(boost).toBe(1.15);
  });

  // Same-project depth gradient under the max-side normalization: a memory
  // written at a project root, recalled from deeper cwds of the SAME project,
  // now sheds boost one level earlier than the old memory-count normalization
  // (which held 1.3x until the project segment left the slice(-4) window).
  // INTENDED semantics, not collateral: the subset relation cannot distinguish
  // "generic home-root memory vs project cwd" from "project-root memory vs
  // subdir cwd" (path tags carry no project boundary), and the gradient gives
  // strictly better relative ordering - an exactly-located memory OUTRANKS a
  // root-located one (1.3x vs 1.2x) where the old normalization tied them.
  // See docs/plans/2026-07-18-s5-path-overlap-tuning.md Risks.
  it('same-project depth gradient: root memory softens from deeper own-project cwds', () => {
    const mem = ['path:skf-user', 'path:proj'];
    expect(pathBoostMultiplier(mem, ['path:skf-user', 'path:proj'])).toBe(1.3);
    expect(pathBoostMultiplier(mem, ['path:skf-user', 'path:proj', 'path:lib'])).toBeCloseTo(1.2, 10);
    expect(pathBoostMultiplier(mem, ['path:skf-user', 'path:proj', 'path:lib', 'path:core'])).toBeCloseTo(1.15, 10);
    expect(pathBoostMultiplier(mem, ['path:proj', 'path:lib', 'path:core', 'path:deep'])).toBeCloseTo(1.075, 10);
  });
});
