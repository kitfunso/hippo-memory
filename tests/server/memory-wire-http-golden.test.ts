// Pins the GET /v1/memories body bytes for one entry with every field set, so a rename of MemoryEntry's fields cannot
// move a key an HTTP client reads.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serve, type ServerHandle } from '../../src/server.js';
import { _resetAblationCacheForTests } from '../../src/core/ablation.js';
import { __resetSessionRecallHistoryHttp } from '../../src/server/routes/recall.js';
import { DEFAULT_TENANT_ID } from '../../src/util/tenant.js';
import { recallableEntry } from '../_helpers/every-field-entry.js';
import { makeRoot } from '../_helpers/make-root.js';
import { CLEARED_ENV, FAKE_NOW } from '../_helpers/recall-golden-seed.js';
import { writeEntry } from '../_helpers/root-forms.js';

let handle: ServerHandle;

beforeEach(async () => {
  for (const k of CLEARED_ENV) vi.stubEnv(k, '');
  vi.stubEnv('HIPPO_ALLOW_KEYLESS_LOCAL', '1');
  vi.stubEnv('HIPPO_FAKE_NOW', FAKE_NOW);
  _resetAblationCacheForTests();
  __resetSessionRecallHistoryHttp();
  const home = makeRoot('wire-http-golden');
  writeEntry(home, { ...recallableEntry(), tenantId: DEFAULT_TENANT_ID });
  handle = await serve({ hippoRoot: home, port: 0 });
});

afterEach(async () => {
  await handle.stop();
  vi.unstubAllEnvs();
  _resetAblationCacheForTests();
});

describe('HTTP memory wire golden', () => {
  it('GET /v1/memories body, plain and with explain=1', async () => {
    const plain = await fetch(`${handle.url}/v1/memories?q=haddock`);
    expect(plain.status).toBe(200);
    expect(await plain.text()).toMatchSnapshot();
    const explained = await fetch(`${handle.url}/v1/memories?q=haddock&explain=1`);
    expect(explained.status).toBe(200);
    expect(await explained.text()).toMatchSnapshot();
  });
});
