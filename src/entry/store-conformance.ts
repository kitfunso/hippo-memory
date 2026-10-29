// The store-kit suite an add-on runs against its own HippoStore. It takes the test runner's
// describe, it and expect, so the package imports no test framework.
import type { HippoStore } from '../base/ports/store-index.js';
import { CONTEXT_READ_CHECKS } from './conformance/context.js';
import { BASE_READ_CHECKS, ENTRY_WRITE_CHECKS } from './conformance/entries.js';
import { KEY_CHECKS } from './conformance/keys.js';
import { registerChecks, type ConformanceRunner } from './conformance/kit.js';
import { AUDIT_CHECKS, RECALL_READ_CHECKS } from './conformance/recall.js';
import { VECTOR_CHECKS } from './conformance/vectors.js';

const CHECKS = {
  'key writes': KEY_CHECKS,
  'entry writes': ENTRY_WRITE_CHECKS,
  'base reads': BASE_READ_CHECKS,
  'context reads': CONTEXT_READ_CHECKS,
  'recall reads': RECALL_READ_CHECKS,
  audit: AUDIT_CHECKS,
  vectors: VECTOR_CHECKS,
};

/** Registers the checks every store must pass, at least one for each required group's methods
 * and each base method; `open` gives a fresh, empty store for each. */
export function runStoreConformance(
  runner: ConformanceRunner,
  open: () => Promise<HippoStore> | HippoStore,
): void {
  for (const [part, checks] of Object.entries(CHECKS)) {
    registerChecks({ runner, open }, `store conformance: ${part}`, checks);
  }
}
