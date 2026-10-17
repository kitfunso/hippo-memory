// A path can carry a memory id or other caller data, so a failed request's log line names the route template instead.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { serve, type ServerHandle } from '../../src/server.js';
import { makeRoot } from '../_helpers/make-root.js';

let handle: ServerHandle;

beforeEach(async () => {
  vi.stubEnv('HIPPO_ALLOW_KEYLESS_LOCAL', '1');
  vi.stubEnv('HIPPO_LOG', 'info');
  handle = await serve({ hippoRoot: makeRoot('log-route-template'), host: '127.0.0.1', port: 0 });
});

afterEach(async () => {
  await handle.stop();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('logs a failed request on a route with an id under the route template, not the path sent', async () => {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const res = await fetch(`${handle.url}/v1/memories/mem_private_note_123`, { method: 'DELETE' });
  expect(res.status).toBe(404);
  const failed = stderr.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(' failed: '));
  expect(failed).toEqual([expect.stringContaining('info: DELETE /v1/memories/:id failed: ')]);
});
