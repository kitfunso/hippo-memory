// Writes hippo's block into an agent's instruction file (CLAUDE.md, AGENTS.md and the like). The block's text, and how
// init recognises one it wrote earlier, are domain/hooks/hook-blocks.ts.

import { writeFileAtomic } from '../../host/atomic-write.js';
import { HOOK_MARKERS, type HookSpec } from '../../domain/hooks/hook-blocks.js';

export { HOOK_MARKERS, HOOKS, hippoBlock, withoutHookBlock, type HookSpec } from '../../domain/hooks/hook-blocks.js';

/** The marked block hippo writes for one agent. */
export function hookBlock(hook: HookSpec): string {
  return `${HOOK_MARKERS.start}\n${hook.content}\n${HOOK_MARKERS.end}`;
}

/** Appends the agent's block to the end of an instruction file whose current text is `existing`. */
export function appendHookBlock(filePath: string, existing: string, hook: HookSpec): void {
  const sep = existing.endsWith('\n') ? '\n' : '\n\n';
  writeFileAtomic(filePath, existing + sep + hookBlock(hook) + '\n');
}
