import * as path from 'path';

/**
 * Extract meaningful path segments from a directory path.
 * Returns tags like ['path:src', 'path:api', 'path:my-project'].
 * Filters out noise (node_modules, .git, Users, home dirs, drive letters).
 */
export function extractPathTags(dirPath: string): string[] {
  const normalized = dirPath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);

  const noise = new Set([
    'users', 'home', 'documents', 'desktop', 'downloads',
    'node_modules', '.git', '.hippo', 'dist', 'build',
    'c:', 'd:', 'tmp', 'temp', 'var', 'usr', 'opt', 'etc',
    'appdata', 'local', 'roaming', 'program files', 'program files (x86)',
  ]);

  return segments
    .filter(s => s.length >= 2 && !noise.has(s.toLowerCase()))
    .slice(-4)  // keep last 4 meaningful segments (most specific)
    .map(s => `path:${s.toLowerCase()}`);
}

/**
 * Compute path overlap score between two sets of path tags.
 * Returns 0..1 where 1 = perfect match.
 * Normalizes by the MORE SPECIFIC side (the larger of the two tag sets),
 * so a memory carrying only a bare/generic path tag can no longer score a
 * full 1.0 against a deeply-nested cwd just because its own tiny tag set
 * is fully contained in the query's — genericity is no longer rewarded.
 */
export function pathOverlapScore(memoryPathTags: string[], currentPathTags: string[]): number {
  if (memoryPathTags.length === 0 || currentPathTags.length === 0) return 0;

  const memSet = new Set(memoryPathTags);
  const matches = currentPathTags.filter(t => memSet.has(t)).length;

  // Normalize by the more specific side (the larger tag set) — kills the
  // genericity reward a memory-count-only normalization gave bare path tags.
  return matches / Math.max(memoryPathTags.length, currentPathTags.length);
}

/** Weight applied to path overlap score when computing the recall boost multiplier. */
export const PATH_BOOST_WEIGHT = 0.3;

/**
 * Multiplier applied to a composite recall score for path locality.
 * Filters the memory's tags to path:* itself so call sites cannot drift.
 * Returns 1.0..1.3.
 */
export function pathBoostMultiplier(memoryTags: string[], currentPathTags: string[]): number {
  const memPathTags = memoryTags.filter(t => t.startsWith('path:'));
  return 1.0 + pathOverlapScore(memPathTags, currentPathTags) * PATH_BOOST_WEIGHT;
}
