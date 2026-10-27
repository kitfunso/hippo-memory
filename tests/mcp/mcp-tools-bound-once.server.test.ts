// A server binds its MCP tools once, at boot: a tool call proves no group need again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { STORE_NOT_PORTED_MESSAGE } from '../../src/base/errors/http-errors.js';
import { serve, type ServerHandle } from '../../src/server.js';
import type { HippoStore } from '../../src/entry/store-kit.js';
import { portOnlyStore } from '../_helpers/port-only-store.js';
import { bindMcpTools } from '../../src/surface/mcp/request.js';
import { CLEARED_ENV } from '../_helpers/recall-golden-seed.js';
import { seedTwoTenants, type TwoTenantFixture } from '../_helpers/store-conformance.js';

// The groups the three called tools need, and so the ones a per-call need check would read.
const NEEDED = ['dagReads', 'reports'] as const;

/** A store that counts each read of a NEEDED group made by a need check (hasGroup), apart from the
 * tools' own reads of the group they run on. */
interface CountingStore {
  readonly store: HippoStore;
  readonly checks: () => number;
}

function counting(store: HippoStore): CountingStore {
  let checks = 0;
  const counted = { ...store };
  for (const group of NEEDED) {
    const value = store[group];
    Object.defineProperty(counted, group, {
      enumerable: true,
      get: () => {
        if (new Error().stack?.includes('hasGroup') === true) checks += 1;
        return value;
      },
    });
  }
  return { store: counted, checks: () => checks };
}

describe('MCP tools on a served store', () => {
  let fixture: TwoTenantFixture;
  let handle: ServerHandle | undefined;

  beforeEach(() => {
    for (const k of CLEARED_ENV) vi.stubEnv(k, '');
    vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
    vi.stubEnv('HIPPO_V1_RPS', '0');
    fixture = seedTwoTenants();
    vi.stubEnv('HIPPO_HOME', join(fixture.dir, 'no-global'));
  });

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    vi.unstubAllEnvs();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it('binds each tool on one host store once, so three tool calls make no need check of their own groups', async () => {
    const { store, checks } = counting(portOnlyStore(fixture.dir, [...NEEDED]));
    const alone = counting(portOnlyStore(fixture.dir, [...NEEDED]));
    bindMcpTools(alone.store);
    // One bind checks each group a tool needs, so the count is live.
    expect(alone.checks()).toBeGreaterThan(0);

    handle = await serve({ hippoRoot: fixture.dir, port: 0, store });
    const atBoot = checks();
    expect(atBoot).toBeGreaterThanOrEqual(alone.checks());

    const calls = [
      ['hippo_drill', { summary_id: 'sum_none' }],
      ['hippo_assemble', { session_id: 'sess-none' }],
      ['hippo_status', {}],
    ] as const;
    for (const [name, args] of calls) {
      const res = await fetch(`${handle.url}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${fixture.tokens.adminA}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      const reply = await res.json();
      expect(reply.error?.message).not.toBe(STORE_NOT_PORTED_MESSAGE);
    }

    expect(checks()).toBe(atBoot);
  });
});
