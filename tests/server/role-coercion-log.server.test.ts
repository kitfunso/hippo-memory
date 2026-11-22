// A resolver role outside the ladder reads as viewer and logs one fixed line that leaves out the value.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { serve, type AuthResolver, type ResolvedBearer, type ServerHandle } from '../../src/server.js';
import { makeRoot } from '../_helpers/make-root.js';
import { initTestStore } from '../_helpers/store-template.js';

let root: string;
let handle: ServerHandle | undefined;

beforeEach(() => {
  root = makeRoot('role-coercion');
  initTestStore(root);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await handle?.stop();
  handle = undefined;
  rmSync(root, { recursive: true, force: true });
});

async function stderrAfterTwoCalls(role: string | undefined): Promise<string[]> {
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  // SAFETY: a role outside the ladder is the case under test, and the type would refuse it.
  const resolver: AuthResolver = () =>
    ({ tenantId: 't-coerce', subject: 'user-x', role, scopes: [] }) as ResolvedBearer;
  handle = await serve({
    hippoRoot: root,
    host: '127.0.0.1',
    port: 0,
    authResolver: resolver,
    rateLimits: { perCaller: 'off', perAddress: 'off' },
  });
  for (let i = 0; i < 2; i++) {
    const res = await fetch(`${handle.url}/v1/memories?q=x`, { headers: { authorization: 'Bearer tok' } });
    expect(res.status).toBe(200);
    await res.body?.cancel();
  }
  return write.mock.calls.map((c) => String(c[0])).filter((line) => line.includes('read it as viewer'));
}

// Runs before the coercion case: the warn is one per process, so a later run would hide a false warn.
describe('a valid resolver role', () => {
  it.each(['admin', 'member', 'viewer'])('logs no coercion line for %s', async (role) => {
    expect(await stderrAfterTwoCalls(role)).toHaveLength(0);
  });
});

describe('a resolver role read as viewer', () => {
  it('logs one warn line for a cased admin, and the line leaves out the value', async () => {
    const lines = await stderrAfterTwoCalls('Admin');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('warn');
    expect(lines[0]).not.toContain('Admin');
  });
});
