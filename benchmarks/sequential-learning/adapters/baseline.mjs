import { createAdapter } from './interface.mjs';

export default createAdapter({
  name: 'No memory',

  async init() {
    // Nothing to set up
  },

  async store(_content, _tags) {
    // No-op: lessons are discarded
  },

  async recall(_query, _budget = undefined) {
    return [];
  },

  async outcome(_good) {
    // No feedback mechanism
  },

  async cleanup() {
    // Nothing to tear down
  },
});
