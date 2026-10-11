import { envGstackSkill, envOpenclawSkill, envScope } from '../util/env.js';

/** Detect the current operational scope from env (HIPPO_SCOPE > GSTACK_SKILL > OPENCLAW_SKILL); returns the name without prefix, or null.
 *  Pure env reads, no I/O, so it is safe on hot paths such as the UserPromptSubmit hook. */
export function detectScope(): string | null {
  const explicit = envScope();
  if (explicit && explicit.trim()) return explicit.trim();

  const gstackSkill = envGstackSkill();
  if (gstackSkill && gstackSkill.trim()) return gstackSkill.trim();

  const openclawSkill = envOpenclawSkill();
  if (openclawSkill && openclawSkill.trim()) return openclawSkill.trim();

  return null;
}

/** Compute scope match between a memory's scope tags and the active scope.
 *  Returns: 1 if matching scope, -1 if mismatching scope, 0 if neutral (no scope on either side). */
export function scopeMatch(memoryTags: string[], activeScope: string | null): -1 | 0 | 1 {
  const scopeTags = memoryTags.filter(t => t.startsWith('scope:'));
  if (scopeTags.length === 0) return 0;  // memory has no scope: always neutral
  if (!activeScope) return 0;            // no active scope: everything neutral
  const scopeKey = `scope:${activeScope}`;
  if (scopeTags.includes(scopeKey)) return 1;   // match
  return -1;                                       // mismatch
}
