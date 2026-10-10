
// Keeps the last meaningful segments, the most specific ones.
const PATH_SEGMENTS_KEPT = 4;

/** Extracts meaningful path segments from a directory as tags like ['path:src', 'path:my-project']; filters noise (node_modules, .git, Users, home dirs,
 * drive letters). */
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
    .slice(-PATH_SEGMENTS_KEPT)
    .map(s => `path:${s.toLowerCase()}`);
}

/** Path overlap score in 0..1 (1 = perfect match), normalized by the MORE SPECIFIC side (the larger tag set),
 * so a bare/generic path tag cannot score 1.0 against a deeply nested cwd just because its tiny tag set is contained in the query's. */
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

/** Multiplier (1.0..1.3) applied to a composite recall score for path locality; filters the memory's tags to path:* itself so call sites cannot drift. */
export function pathBoostMultiplier(memoryTags: string[], currentPathTags: string[]): number {
  const memPathTags = memoryTags.filter(t => t.startsWith('path:'));
  return 1.0 + pathOverlapScore(memPathTags, currentPathTags) * PATH_BOOST_WEIGHT;
}
