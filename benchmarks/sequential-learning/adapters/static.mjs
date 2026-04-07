/**
 * Static Pre-loaded Memory Adapter
 *
 * All lessons are loaded during init(). No new lessons are stored during the
 * sequence. This simulates a system with perfect prior knowledge but no
 * ability to learn from runtime experience.
 *
 * Uses simple text matching for recall (no external dependencies).
 * The hit rate should be roughly flat across early/mid/late phases.
 */

import { createAdapter } from './interface.mjs';
import { TRAP_CATEGORIES } from '../traps.mjs';

export default createAdapter({
  name: 'Static memory',

  /** @type {Array<{content: string, tags: string[]}>} */
  _entries: [],

  async init() {
    // Pre-load every lesson from every trap category
    this._entries = TRAP_CATEGORIES.map((cat) => ({
      content: cat.lesson,
      tags: [...cat.tags],
    }));
  },

  async store(_content, _tags) {
    // No-op: static memory does not learn during the sequence
  },

  async recall(query) {
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 3);

    const scored = this._entries.map((entry) => {
      const contentLower = entry.content.toLowerCase();
      const tagsJoined = entry.tags.join(' ').toLowerCase();

      // Score: count how many query words appear in content or tags
      let hits = 0;
      for (const word of queryWords) {
        if (contentLower.includes(word)) hits += 1;
        if (tagsJoined.includes(word)) hits += 1;
      }

      const score = queryWords.length > 0 ? hits / (queryWords.length * 2) : 0;
      return { content: entry.content, score, tags: entry.tags };
    });

    // Return top 5, descending by score, excluding zero-score results
    return scored
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(({ content, score }) => ({ content, score }));
  },

  async outcome(_good) {
    // No feedback mechanism for static memory
  },

  async cleanup() {
    this._entries = [];
  },
});
