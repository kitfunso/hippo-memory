// The global store: where it lives, creating it, and embedding a copy promoted into it.

import * as fs from 'fs';
import type { MemoryEntry } from '../core/memory.js';
import { resolveGlobalRootDir } from '../core/project-identity.js';
import { initStore } from '../store/open.js';
import { embedMemory } from '../search/embed-memories.js';

/** Returns the path to the global Hippo store.
 *  Resolution order: $HIPPO_HOME > $XDG_DATA_HOME/hippo > ~/.hippo/ */
export function getGlobalRoot(): string {
  // Single source of truth lives in project-identity.ts (leaf) so db migrations
  // can resolve the same path without a shared.ts import cycle.
  return resolveGlobalRootDir();
}

/** Ensure the global store exists. */
export function initGlobal(): void {
  const globalRoot = getGlobalRoot();
  if (!fs.existsSync(globalRoot)) {
    initStore(globalRoot);
  } else {
    // Ensure subdirectories exist in case partially initialized
    initStore(globalRoot);
  }
}

/** Fire-and-forget: embedMemory gates on availability and never rejects. */
export function embedGlobalCopy(globalEntry: MemoryEntry): void {
  void embedMemory(getGlobalRoot(), globalEntry);
}
