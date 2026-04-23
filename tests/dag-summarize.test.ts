import { describe, it, expect } from 'vitest';
import { generateDagSummary } from '../src/dag.js';

describe('generateDagSummary', () => {
  it('produces a summary from cluster label and member contents', async () => {
    const mockFetcher = async () =>
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'John is a dedicated basketball player who trains daily and aims to improve his shooting percentage and win a championship.' }],
        }),
        { status: 200 },
      );

    const summary = await generateDagSummary(
      'John: basketball',
      [
        'John plays basketball daily',
        'John wants to improve shooting percentage',
        'John dreams of winning a championship',
      ],
      { apiKey: 'test', fetcher: mockFetcher as typeof fetch },
    );

    expect(summary).not.toBeNull();
    expect(summary!).toContain('basketball');
  });

  it('returns null on API failure', async () => {
    const mockFetcher = async () => new Response('', { status: 500 });
    const summary = await generateDagSummary('label', ['fact'], {
      apiKey: 'test',
      fetcher: mockFetcher as typeof fetch,
    });
    expect(summary).toBeNull();
  });

  it('returns null when response text is too short', async () => {
    const mockFetcher = async () =>
      new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'too short' }] }),
        { status: 200 },
      );
    const summary = await generateDagSummary('label', ['fact'], {
      apiKey: 'test',
      fetcher: mockFetcher as typeof fetch,
    });
    expect(summary).toBeNull();
  });
});
