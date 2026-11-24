import { createAdapter } from './interface.mjs';
import { TRAP_CATEGORIES } from '../traps.mjs';

export default createAdapter({
  name: 'Static memory',

  /** @type {Array<{content: string, tags: string[]}>} */
  _entries: [],

  async init() {
    this._entries = TRAP_CATEGORIES.map((cat) => ({
      content: cat.lesson,
      tags: [...cat.tags],
    }));
  },

  async store(_content, _tags) {
  },

  async recall(query, _budget = undefined) {
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 3);

    const scored = this._entries.map((entry) => {
      const contentLower = entry.content.toLowerCase();
      const tagsJoined = entry.tags.join(' ').toLowerCase();

      let hits = 0;
      for (const word of queryWords) {
        if (contentLower.includes(word)) hits += 1;
        if (tagsJoined.includes(word)) hits += 1;
      }

      const score = queryWords.length > 0 ? hits / (queryWords.length * 2) : 0;
      return { content: entry.content, score, tags: entry.tags };
    });

    return scored
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(({ content, score }) => ({ content, score }));
  },

  async outcome(_good) {
  },

  async cleanup() {
    this._entries = [];
  },
});
