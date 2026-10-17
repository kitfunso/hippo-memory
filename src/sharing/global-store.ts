// The global store: where it lives and creating it.

import * as fs from 'fs';
import { resolveGlobalRootDir } from '../core/project-identity.js';
import { initStore } from '../store/open.js';

/** The global store's folder: $HIPPO_HOME, else $XDG_DATA_HOME/hippo, else ~/.hippo/. */
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
