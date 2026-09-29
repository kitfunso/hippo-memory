// A captured modal rule keeps the words before its keyword, so a negation or subject is never cut off.
import { describe, expect, it } from 'vitest';
import { extractFromText } from '../src/capture.js';

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

  it('counts the 200-char bound from the keyword, so a long subject does not cut the object', () => {
    const lead = 'When the weekly release train leaves the shared build machine for the storage team we ';
    const object = 'copy the nightly artifacts from the staging bucket into the release bucket after checking the manifest checksum against the signed list the build step publishes for auditors';
    expect(object.length).toBeLessThan(200);
    expect((lead + object).length).toBeGreaterThan(200);
    const [item] = rules(`${lead}must ${object}.`);
    expect(item.content.startsWith(lead)).toBe(true);
    expect(item.content.endsWith('publishes for auditors')).toBe(true);
    expect(item.content.length).toBeGreaterThan(200);
  });

  it('falls back to the keyword-start form after a lead over 300 chars', () => {
    const lead = 'After the long migration step '.repeat(11);
    expect(lead.length).toBeGreaterThan(300);
    const [item] = rules(`${lead}we must never push master to origin before review.`);
    expect(item.content).toBe('must never push master to origin before review');
  });

  it('falls back to the keyword-start form when the keyword sits inside a bracket', () => {
    const [item] = rules('The release notes (we must never skip them) live in the wiki.');
    expect(item.content.startsWith('must never skip them')).toBe(true);
  });
});
