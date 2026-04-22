import { execFileSync } from 'node:child_process';

/**
 * Detect the current operational scope from environment signals.
 * Returns a scope name string (no prefix), or null if no scope detected.
 * Priority: explicit > env var > git branch.
 */
export function detectScope(): string | null {
  // 1. Explicit env var (set by orchestrators, hooks, or the user)
  const explicit = process.env['HIPPO_SCOPE'];
  if (explicit && explicit.trim()) return explicit.trim();

  // 2. gstack skill env var (set when a gstack skill is running)
  const gstackSkill = process.env['GSTACK_SKILL'];
  if (gstackSkill && gstackSkill.trim()) return gstackSkill.trim();

  // 3. OpenClaw skill
  const openclawSkill = process.env['OPENCLAW_SKILL'];
  if (openclawSkill && openclawSkill.trim()) return openclawSkill.trim();

  // 4. Git branch (feature branches are meaningful scopes)
  try {
    const branch = execFileSync('git', ['branch', '--show-current'], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    // Skip default branches — they're not meaningful scopes
    if (branch && !['main', 'master', 'develop', 'dev'].includes(branch)) {
      return branch;
    }
  } catch {
    // Not in a git repo or git not available — fine, return null
  }

  return null;
}

/**
 * Compute scope match between a memory's scope tags and the active scope.
 * Returns: 1 if matching scope, -1 if mismatching scope, 0 if neutral (no scope on either side).
 */
export function scopeMatch(memoryTags: string[], activeScope: string | null): -1 | 0 | 1 {
  const scopeTags = memoryTags.filter(t => t.startsWith('scope:'));
  if (scopeTags.length === 0) return 0;  // memory has no scope — always neutral
  if (!activeScope) return 0;            // no active scope — everything neutral
  const scopeKey = `scope:${activeScope}`;
  if (scopeTags.includes(scopeKey)) return 1;   // match
  return -1;                                       // mismatch
}
