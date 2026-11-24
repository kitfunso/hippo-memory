import { createAdapter } from './interface.mjs';

export default createAdapter({
  name: 'No memory',

  async init() {
  },

  async store(_content, _tags) {
  },

  async recall(_query, _budget = undefined) {
    return [];
  },

  async outcome(_good) {
  },

  async cleanup() {
  },
});
