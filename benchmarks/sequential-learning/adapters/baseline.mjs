/**
 * No-Memory Baseline Adapter
 *
 * The agent has no memory system. recall() always returns an empty array,
 * store() is a no-op. This represents the worst case: every trap is hit
 * every time, yielding a 100% trap-hit-rate across all phases.
 */

import { createAdapter } from './interface.mjs';

export default createAdapter({
  name: 'No memory',

  async init() {
    // Nothing to set up
  },

  async store(_content, _tags) {
    // No-op: lessons are discarded
  },

  async recall(_query) {
    // No memory to search
    return [];
  },

  async outcome(_good) {
    // No feedback mechanism
  },

  async cleanup() {
    // Nothing to tear down
  },
});
