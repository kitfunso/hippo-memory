// A captured modal rule keeps the words before its keyword, so a negation or subject is never cut off.
import { describe, expect, it } from 'vitest';
import { extractFromText } from '../src/capture/extract.js';

const rules = (text: string) => extractFromText(text).filter((i) => i.category === 'rule');

describe('rule capture keeps its lead', () => {
  it('keeps the subject of "We must never push master ..."', () => {
    const [item] = rules('We must never push master to origin before review.');
    expect(item.content).toBe('We must never push master to origin before review');
  });

  it('does not read "Whenever" as a rule', () => {
    expect(rules('Whenever the build breaks, clear dist.')).toEqual([]);
  });

  it('keeps a negation that comes before the keyword', () => {
    const sentences = [
      'It is not true that we must rebase before merging.',
      'Nobody said you should always squash the commits.',
      'I doubt we must never touch the lockfile.',
      'Not every job must run on the main runner.',
    ];
    for (const sentence of sentences) {
      const found = rules(sentence);
      expect(found, sentence).toHaveLength(1);
      expect(sentence.startsWith(found[0].content), sentence).toBe(true);
      expect(found[0].content, sentence).toMatch(/\b(?:must|always|never)\b/);
    }
  });

  it('keeps a long subject and its whole object in one sentence', () => {
    const lead = 'When the weekly release train leaves the shared build machine for the storage team we ';
    const object = 'copy the nightly artifacts from the staging bucket into the release bucket after checking the manifest checksum against the signed list the build step publishes for auditors';
    expect((lead + object).length).toBeGreaterThan(200);
    const [item] = rules(`${lead}must ${object}.`);
    expect(item.content).toBe(`${lead}must ${object}`);
  });

  it('keeps a sentence up to 500 chars whole and skips a longer one', () => {
    const rule = 'we must never push master to origin before review.';
    const [kept] = rules(`${'After the long migration step '.repeat(11)}${rule}`);
    expect(kept.content.endsWith('before review')).toBe(true);
    expect(kept.content.startsWith('After the long migration step')).toBe(true);
    expect(rules(`${'After the long migration step '.repeat(18)}${rule}`)).toEqual([]);
  });

  it('skips a keyword that sits inside a bracket', () => {
    expect(rules('The release notes (we must never skip them) live in the wiki.')).toEqual([]);
  });
});
