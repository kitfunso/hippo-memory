import { describe, it, expect } from 'vitest';
import { extractFacts } from '../src/learn/extract.js';
import { extractFromTexts, isStandingRule } from '../src/capture/extract.js';

function mockFetcher(body: string, ok = true): typeof fetch {
  // A real Response satisfies typeof fetch's return type directly, so no
  // cast is needed: extractFacts only reads res.ok and res.json().
  return async () =>
    new Response(JSON.stringify({ content: [{ text: body }] }), { status: ok ? 200 : 500 });
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
    const fetcher: typeof fetch = () => { throw new Error('network down'); };
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

const STANDING = [
  'Never edit CHANGELOG.md by hand.',
  'No: run the linter first, because CI fails without it.',
  'Always run the formatter before committing.',
  'Make sure every migration has a down step.',
  "No, use pnpm here, because the lockfile is pnpm's.",
  'Right: keep tests beside the code, because the build globs them.',
  'Wrong, the config lives in the repo root, because the loader walks up from there.',
  'Not quite: name the branch after the ticket, because the bot reads it.',
  'Correct, put secrets in the vault, because the env file is committed.',
  'Never embed secrets in the build.',
  'Secrets are never logged.',
  'Branch names are always prefixed with the ticket id.',
];
const NOT_STANDING = [
  'It always marked the override as off.',
  'Please fix it and make sure the tests pass.',
  'It never returned the right count.',
  'This always happened when the cache was cold.',
  'Please make sure the build passes now.',
  'No, because it crashed.',
  'Make sure the tests pass this time.',
  'No, I tried that already, because it failed.',
  'Yes, keep doing that, because it works.',
  'Yes, that is fine, because the build passed.',
  "No, that's wrong, because the count is off.",
  'Right, it works now, because the cache was cleared.',
];

describe('isStandingRule', () => {
  it.each(STANDING)('accepts %s', (sentence) => expect(isStandingRule(sentence)).toBe(true));
  it.each(NOT_STANDING)('rejects %s', (sentence) => expect(isStandingRule(sentence)).toBe(false));

  it('lets a standing phrase override a one-off marker', () => {
    expect(isStandingRule('Always run the linter first, not just this time.')).toBe(true);
    expect(isStandingRule('From now on make sure the tests pass.')).toBe(true);
  });
});

describe("capture reads a person's reply as a rule", () => {
  const REPLIES = STANDING.filter((s) => /^(?:no|yes|right|correct|wrong|not quite)\b/i.test(s));

  it.each(REPLIES)('extracts %s as a rule from the person', (reply) => {
    const [item, ...rest] = extractFromTexts([reply], 1);
    expect(rest).toEqual([]);
    expect(item).toMatchObject({ category: 'rule', fromUser: true });
  });

  it('keeps the whole reply, opener and reason included', () => {
    const [item] = extractFromTexts(['Yes, keep doing that: squash before merging, because history stays readable.'], 1);
    expect(item.content).toBe('Yes, keep doing that: squash before merging, because history stays readable');
  });

  it('joins a reply split over sentences up to the one that gives the reason', () => {
    const items = extractFromTexts(['No: put each migration in its own file. Name the file after the ticket. Keep it small, because the review bot reads them.'], 1);
    expect(items.map((i) => i.content)).toEqual([
      'No: put each migration in its own file. Name the file after the ticket. Keep it small, because the review bot reads them',
    ]);
  });

  it('does not reach past four sentences for a reason', () => {
    const text = 'No: put each migration in its own file. Name the file after the ticket. Keep it small. Review it twice. It reads well, because the bot parses it.';
    expect(extractFromTexts([text], 1).filter((i) => i.content.startsWith('No:'))).toEqual([]);
  });

  it('reads agent text with a reply opener exactly as before', () => {
    expect(extractFromTexts(['No: run the linter first, because CI fails without it.'])).toEqual([]);
    expect(extractFromTexts(['No, never edit the lockfile by hand, because CI diffs it.'])).toEqual([
      { content: 'No, never edit the lockfile by hand, because CI diffs it', category: 'rule', tags: ['rule', 'captured'] },
    ]);
  });

  it('leaves a bare reason with no statement before it uncaptured', () => {
    expect(extractFromTexts(['No, because it crashed.'], 1)).toEqual([]);
  });
});
