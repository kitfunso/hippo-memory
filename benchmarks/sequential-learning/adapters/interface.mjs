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
 * @property {(query: string) => Promise<RecallResult[]>} recall              - Retrieve memories relevant to a query (return top-5)
 * @property {(good: boolean) => Promise<void>} outcome                       - Feedback on the last recall (did it help?)
 * @property {() => Promise<void>} cleanup                                    - Tear down the memory store (remove temp dirs)
 */

/**
 * Create a validated adapter from a plain object.
 * Throws if any required method is missing.
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
  return adapter;
}
