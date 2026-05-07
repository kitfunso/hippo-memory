/**
 * v1.7.2 T4 — thin-client RecallOpts parity sweep.
 *
 * Pre-v1.7.2 `client.ts::recall` serialized only `q`, `limit`, `mode`,
 * `scope`, `include_continuity`. Server already accepted three more
 * (`fresh_tail_count`, `fresh_tail_session_id`, `summarize_overflow`); v1.7.2
 * adds a fourth (`scorer_window`). Adding only `scorer_window` would have
 * perpetuated the drift. Pin all four serialize correctly.
 *
 * Test spies on fetch to observe the wire format directly (codex P2-2:
 * test the URL the client builds, not internal builder calls).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { recall } from '../src/client.js';

describe('client RecallOpts parity sweep over the wire (v1.7.2 T4)', () => {
  let originalFetch: typeof fetch;

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  it('serializes all four v1.7.2 RecallOpts transport fields as query params', async () => {
    originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ results: [], total: 0, tokens: 0, windowSize: 200 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await recall('http://localhost:9999', undefined, {
      query: 'alpha',
      freshTailCount: 5,
      freshTailSessionId: 'sess-A',
      summarizeOverflow: true,
      scorerWindow: 50,
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const url = String(fetchSpy.mock.calls[0]![0]);
    expect(url).toContain('fresh_tail_count=5');
    expect(url).toContain('fresh_tail_session_id=sess-A');
    expect(url).toContain('summarize_overflow=1');
    expect(url).toContain('scorer_window=50');
  });

  it('omits all four when undefined (no leakage of empty params)', async () => {
    originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ results: [], total: 0, tokens: 0, windowSize: 200 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await recall('http://localhost:9999', undefined, {
      query: 'alpha',
    });

    const url = String(fetchSpy.mock.calls[0]![0]);
    expect(url).not.toContain('fresh_tail_count');
    expect(url).not.toContain('fresh_tail_session_id');
    expect(url).not.toContain('summarize_overflow');
    expect(url).not.toContain('scorer_window');
  });

  it('serializes summarize_overflow=0 when summarizeOverflow is false (not omitted)', async () => {
    originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ results: [], total: 0, tokens: 0, windowSize: 200 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await recall('http://localhost:9999', undefined, {
      query: 'alpha',
      summarizeOverflow: false,
    });

    const url = String(fetchSpy.mock.calls[0]![0]);
    expect(url).toContain('summarize_overflow=0');
    expect(url).not.toContain('summarize_overflow=1');
  });
});
