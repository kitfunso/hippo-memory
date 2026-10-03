// A refine call that fails still returns null, but now says why on stderr, and never prints the API key.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refineSemanticMemory } from '../src/refine-llm.js';

const API_KEY = 'refine-test-key-0000';
let stderr: ReturnType<typeof vi.spyOn>;

function warnLines(): string[] {
  return stderr.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('refine'));
}

beforeEach(() => {
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderr.mockRestore();
});

describe('refineSemanticMemory failure logging', () => {
  it.each([
    ['the request throws', async (): Promise<Response> => { throw new Error('socket hang up'); }, /request failed: socket hang up/],
    ['the API answers non-2xx', async (): Promise<Response> => new Response('{"error":"bad"}', { status: 400 }), /HTTP 400/],
    ['the body is not JSON', async (): Promise<Response> => new Response('not json', { status: 200 }), /unreadable response/],
    ['the reply is too short', async (): Promise<Response> => new Response(JSON.stringify({ content: [{ text: 'ok' }] }), { status: 200 }), /empty or too short/],
  ])('returns null and logs one warning when %s', async (_label, fetcher, pattern) => {
    const result = await refineSemanticMemory('merged', [], { apiKey: API_KEY, fetcher });
    expect(result).toBeNull();
    const lines = warnLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[hippo\] warn: refine: /);
    expect(lines[0]).toMatch(pattern);
    expect(lines.join('')).not.toContain(API_KEY);
  });
});
