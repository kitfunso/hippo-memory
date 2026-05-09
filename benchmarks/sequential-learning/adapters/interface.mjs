/**
 * Memory Adapter Interface
 *
 * Every memory adapter must implement this interface to participate in the
 * Sequential Learning Benchmark. Adapters wrap a memory system and expose
 * five operations: init, store, recall, outcome, and cleanup.
 *
 * To add your own memory system:
 *   1. Copy this file as a starting point
 *   2. Implement all five methods
 *   3. Export a default instance
 *   4. Register it in run.mjs
 *
 * @example
 *   import { createAdapter } from './interface.mjs';
 *
 *   export default createAdapter({
 *     name: 'my-memory',
 *     async init() { ... },
 *     async store(content, tags) { ... },
 *     async recall(query) { ... },
 *     async outcome(good) { ... },
 *     async cleanup() { ... },
 *   });
 */

/**
 * @typedef {Object} RecallResult
 * @property {string} content - The stored memory content
 * @property {number} score   - Relevance score (0-1, higher is better)
 */

/**
 * @typedef {Object} MemoryAdapter
 * @property {string} name                                                    - Human-readable adapter name
 * @property {() => Promise<void>} init                                       - Set up the memory store (create temp dirs, initialize state)
 * @property {(content: string, tags: string[]) => Promise<void>} store       - Store a lesson learned from a trap hit
 * @property {(query: string, budget?: number) => Promise<RecallResult[]>} recall - Retrieve memories relevant to a query (return top-5). v1.7.6: optional `budget` controls token budget for retrieval; adapter MAY ignore.
 * @property {(good: boolean) => Promise<void>} outcome                       - Feedback on the last recall (did it help?)
 * @property {() => Promise<void>} cleanup                                    - Tear down the memory store (remove temp dirs)
 *
 * v1.7.5 -- optional B3 dlPFC goal-stack hooks. Either supply BOTH or NEITHER.
 * @property {((name: string) => Promise<string>)} [pushGoal]                 - Push an active goal at task start. Returns the goal id
 *                                                                              (opaque string, e.g. "g_<16hex>"). Adapter must thread the
 *                                                                              goal's session id into subsequent recall calls so the
 *                                                                              goal-stack boost activates.
 * @property {((id: string, good: boolean) => Promise<void>)} [completeGoal]  - Complete the goal at task end. `good` is the outcome
 *                                                                              (true = trap avoided, false = trap hit). Adapter MAY
 *                                                                              propagate strength multipliers per its own contract.
 */

/**
 * Create a validated adapter from a plain object.
 * Throws if any required method is missing, or if the optional v1.7.5
 * goal-stack hooks are supplied unpaired (must be both or neither).
 *
 * @param {MemoryAdapter} adapter
 * @returns {MemoryAdapter}
 */
export function createAdapter(adapter) {
  const required = ['name', 'init', 'store', 'recall', 'outcome', 'cleanup'];
  for (const key of required) {
    if (!(key in adapter)) {
      throw new Error(`Adapter missing required field: ${key}`);
    }
  }
  for (const key of required.slice(1)) {
    if (typeof adapter[key] !== 'function') {
      throw new Error(`Adapter.${key} must be a function`);
    }
  }
  // v1.7.5 -- pushGoal / completeGoal must be supplied as a pair.
  const hasPush = 'pushGoal' in adapter;
  const hasComplete = 'completeGoal' in adapter;
  if (hasPush !== hasComplete) {
    throw new Error(
      hasPush
        ? 'Adapter supplies pushGoal but missing completeGoal -- the v1.7.5 B3 hooks are paired'
        : 'Adapter supplies completeGoal but missing pushGoal -- the v1.7.5 B3 hooks are paired',
    );
  }
  if (hasPush && typeof adapter.pushGoal !== 'function') {
    throw new Error('Adapter.pushGoal must be a function');
  }
  if (hasComplete && typeof adapter.completeGoal !== 'function') {
    throw new Error('Adapter.completeGoal must be a function');
  }
  return adapter;
}
