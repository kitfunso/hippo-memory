import { describe, it, expect } from 'vitest';
import { extractFacts } from '../src/extract.js';

function mockFetcher(body: string, ok = true): typeof fetch {
  return (async () => ({
    ok,
    status: ok ? 200 : 500,
    async json() { return { content: [{ text: body }] }; },
    async text() { return JSON.stringify({ content: [{ text: body }] }); },
  })) as unknown as typeof fetch;
}

describe('extractFacts', () => {
  it('returns correct ExtractedFact[] from mocked Claude response', async () => {
    const response = JSON.stringify([
      { content: 'Alice prefers dark roast coffee', tags: ['speaker:Alice', 'topic:coffee'], valence: 'neutral' },
      { content: 'Bob joined the team in March 2025', tags: ['speaker:Bob', 'topic:team'], valence: 'positive' },
    ]);
    const fetcher = mockFetcher(response);

    const facts = await extractFacts('some conversation text', { apiKey: 'test', fetcher });

    expect(facts).toHaveLength(2);
    expect(facts[0]!.content).toBe('Alice prefers dark roast coffee');
    expect(facts[0]!.tags).toEqual(['speaker:Alice', 'topic:coffee']);
    expect(facts[0]!.valence).toBe('neutral');
    expect(facts[1]!.content).toBe('Bob joined the team in March 2025');
    expect(facts[1]!.valence).toBe('positive');
  });

  it('returns [] on API failure', async () => {
    const fetcher = mockFetcher('ignored', false);
    const facts = await extractFacts('some text', { apiKey: 'test', fetcher });
    expect(facts).toEqual([]);
  });

  it('returns [] on malformed JSON', async () => {
    const fetcher = mockFetcher('this is not json at all');
    const facts = await extractFacts('some text', { apiKey: 'test', fetcher });
    expect(facts).toEqual([]);
  });

  it('caps at 8 facts max', async () => {
    const tenFacts = Array.from({ length: 10 }, (_, i) => ({
      content: `Fact number ${i + 1} about something`,
      tags: [`speaker:Person${i}`],
      valence: 'neutral',
    }));
    const fetcher = mockFetcher(JSON.stringify(tenFacts));

    const facts = await extractFacts('long conversation', { apiKey: 'test', fetcher });
    expect(facts).toHaveLength(8);
  });

  it('returns [] when fetch throws', async () => {
    const fetcher = (() => { throw new Error('network down'); }) as unknown as typeof fetch;
    const facts = await extractFacts('text', { apiKey: 'test', fetcher });
    expect(facts).toEqual([]);
  });

  it('skips items with invalid content', async () => {
    const response = JSON.stringify([
      { content: 'ab', tags: [], valence: 'neutral' },
      { content: 'Alice has a dog named Rex', tags: ['speaker:Alice'], valence: 'neutral' },
      { content: 42, tags: [], valence: 'neutral' },
    ]);
    const fetcher = mockFetcher(response);
    const facts = await extractFacts('text', { apiKey: 'test', fetcher });
    expect(facts).toHaveLength(1);
    expect(facts[0]!.content).toBe('Alice has a dog named Rex');
  });

  it('defaults valence to neutral for unknown values', async () => {
    const response = JSON.stringify([
      { content: 'Alice said something interesting', tags: [], valence: 'unknown_valence' },
    ]);
    const fetcher = mockFetcher(response);
    const facts = await extractFacts('text', { apiKey: 'test', fetcher });
    expect(facts).toHaveLength(1);
    expect(facts[0]!.valence).toBe('neutral');
  });
});
