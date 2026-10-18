// Every body field on the memory, key and prediction routes has a length cap; an over-long value is a 400 that names the
// field and the cap, not the value.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { serve, type ServerHandle } from '../../src/server.js';
import { createApiKey } from '../../src/store/auth.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import type { JsonValue } from '../../src/util/json.js';
import { makeRoot } from '../_helpers/make-root.js';

let home: string;
let handle: ServerHandle;
let token: string;

type Body = { [key: string]: JsonValue };

async function post(path: string, body: Body): Promise<{ status: number; error: string }> {
  const res = await fetch(`${handle.url}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // SAFETY: every route answers a JSON object; a parse failure fails the test.
  const json = JSON.parse(text) as { error?: string };
  return { status: res.status, error: json.error ?? '' };
}

const over = (n: number): string => 'x'.repeat(n + 1);

beforeAll(async () => {
  home = makeRoot('body-field-caps');
  const db = openHippoDb(home);
  try {
    token = createApiKey(db, { tenantId: 'default', label: 'caps', role: 'admin' }).plaintext;
  } finally {
    closeHippoDb(db);
  }
  vi.stubEnv('HIPPO_V1_RPS', '0');
  vi.stubEnv('HIPPO_CALLER_RPS', '0');
  handle = await serve({ hippoRoot: home, port: 0 });
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await handle.stop();
  rmSync(home, { recursive: true, force: true });
});

const cases: Array<[string, string, Body, RegExp]> = [
  ['memory kind', '/v1/memories', { content: 'c', kind: over(256) }, /kind exceeds 256-character cap/],
  ['memory scope', '/v1/memories', { content: 'c', scope: over(256) }, /scope exceeds 256-character cap/],
  ['memory owner', '/v1/memories', { content: 'c', owner: over(256) }, /owner exceeds 256-character cap/],
  [
    'memory artifactRef',
    '/v1/memories',
    { content: 'c', artifactRef: over(4096) },
    /artifactRef exceeds 4096-character cap/,
  ],
  [
    'memory tag length',
    '/v1/memories',
    { content: 'c', tags: [over(256)] },
    /each tags entry exceeds 256-character cap/,
  ],
  [
    'memory tag count',
    '/v1/memories',
    { content: 'c', tags: Array.from({ length: 101 }, () => 't') },
    /tags exceeds 100-item cap/,
  ],
  [
    'memory project name',
    '/v1/memories',
    { content: 'c', project: { name: over(256) } },
    /project.name exceeds 256-character cap/,
  ],
  ['archive reason', '/v1/memories/mem_1/archive', { reason: over(4096) }, /reason exceeds 4096-character cap/],
  ['outcome id', '/v1/outcome', { good: true, ids: [over(256)] }, /each ids entry exceeds 256-character cap/],
  ['key label', '/v1/auth/keys', { label: over(256) }, /label exceeds 256-character cap/],
  ['prediction classTag', '/v1/predictions', { claim: 'c', classTag: over(256) }, /classTag exceeds 256-character cap/],
  [
    'prediction unit',
    '/v1/predictions',
    { claim: 'c', classTag: 't', unit: over(256) },
    /unit exceeds 256-character cap/,
  ],
  [
    'prediction targetDate',
    '/v1/predictions',
    { claim: 'c', classTag: 't', targetDate: over(64) },
    /targetDate exceeds 64-character cap/,
  ],
];

describe('body field caps', () => {
  it.each(cases)('%s over its cap is a 400 that names the field and the cap', async (_name, path, body, message) => {
    const r = await post(path, body);
    expect(r.status).toBe(400);
    expect(r.error).toMatch(message);
    expect(r.error).not.toContain('xxxx');
  });

  it('a value at its cap is accepted', async () => {
    const r = await post('/v1/memories', { content: 'cap check', scope: 'x'.repeat(256), tags: ['t'.repeat(256)] });
    expect(r.status).toBe(200);
  });
});
