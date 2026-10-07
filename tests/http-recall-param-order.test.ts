// Characterization of GET /v1/memories query parsing: which bad param wins, and that parsing runs before auth.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory, Layer, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { serve, type ServerHandle } from '../src/server.js';
import { makeRoot } from './_helpers/make-root.js';

let home: string;
let handle: ServerHandle;

beforeEach(async () => {
  home = makeRoot('http-recall-order');
  writeEntry(home, createMemory('alpha bravo', {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    layer: Layer.Episodic,
    tenantId: 'default',
  }));
  handle = await serve({ hippoRoot: home, port: 0 });
});
afterEach(async () => {
  await handle.stop();
  rmSync(home, { recursive: true, force: true });
});

async function errorFor(params: string, headers: Record<string, string> = {}): Promise<[number, string]> {
  const res = await fetch(`${handle.url}/v1/memories?${params}`, { headers });
  // SAFETY: every error reply from this route is the shared {error} JSON shape.
  const body = (await res.json()) as { error: string };
  return [res.status, body.error];
}

describe('GET /v1/memories query parsing', () => {
  const long = 'x'.repeat(257);

  it('reports the first bad param in parse order', async () => {
    expect(await errorFor('mode=nope')).toEqual([400, 'q is required']);
    expect(await errorFor('q=alpha&mode=nope&fresh_tail_count=-1')).toEqual([400, "mode must be 'bm25', 'hybrid', or 'physics'"]);
    expect(await errorFor(`q=alpha&fresh_tail_count=-1&fresh_tail_session_id=${long}`)).toEqual([400, 'fresh_tail_count must be a non-negative number']);
    expect(await errorFor(`q=alpha&fresh_tail_session_id=${long}&scorer_window=2000`)).toEqual([400, 'fresh_tail_session_id exceeds 256-character cap']);
    expect(await errorFor(`q=alpha&scorer_window=2000&session_id=${long}`)).toEqual([400, 'scorer_window must be <= 1000']);
    expect(await errorFor(`q=alpha&session_id=${long}`)).toEqual([400, 'session_id exceeds 256-character cap']);
  });

  it('rejects a bad param before it checks the bearer token', async () => {
    const [status] = await errorFor('q=alpha', { Authorization: 'Bearer hk_not_a_real_key' });
    expect(status).toBe(401);
    expect(await errorFor('q=alpha&mode=nope', { Authorization: 'Bearer hk_not_a_real_key' })).toEqual([400, "mode must be 'bm25', 'hybrid', or 'physics'"]);
  });

  it('marks continuity replies no-store and leaves plain ones cacheable', async () => {
    const plain = await fetch(`${handle.url}/v1/memories?q=alpha`);
    expect(plain.status).toBe(200);
    expect(plain.headers.get('cache-control')).toBeNull();
    const continuity = await fetch(`${handle.url}/v1/memories?q=alpha&include_continuity=true&fresh_tail_session_id=&session_id=%20%20`);
    expect(continuity.status).toBe(200);
    expect(continuity.headers.get('cache-control')).toBe('no-store');
    // SAFETY: a 200 from this route is a serialized RecallResult.
    const body = (await continuity.json()) as { results: Array<{ content: string }> };
    expect(body.results.map((r) => r.content)).toEqual(['alpha bravo']);
  });
});
