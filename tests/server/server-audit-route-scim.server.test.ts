import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import type { ServerHandle } from '../../src/server.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { makeStore } from '../_helpers/make-root.js';
import { serveAsAdmin } from '../_helpers/admin-server.js';
import { runCliOut } from '../_helpers/run-cli-as.js';

const SCIM_OPS = [
  'scim_user_create',
  'scim_user_replace',
  'scim_user_patch',
  'scim_user_delete',
  'scim_group_create',
  'scim_group_replace',
  'scim_group_patch',
  'scim_group_delete',
] as const;
const ACTOR = 'system:scim-token:acme';

interface Row {
  op: string;
  actor: string;
  targetId?: string;
  metadata?: unknown;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('SCIM user and group ops through the audit readers', () => {
  let base: string;
  let home: string;
  let handle: ServerHandle;

  beforeEach(async () => {
    ({ base, root: home } = makeStore('audit-route-scim'));
    vi.stubEnv('HIPPO_HOME', home);
    handle = await serveAsAdmin({ hippoRoot: home, port: 0 });
    await sqliteStore(home).appendAuditEvents(
      SCIM_OPS.map((op, i) => ({
        tenantId: 'default',
        actor: ACTOR,
        op,
        targetId: `user-${i}`,
        metadata: { event: `ev-${i}`, active: op !== 'scim_user_delete', revokeKeys: op === 'scim_user_delete' },
      })),
    );
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it.each(SCIM_OPS.map((op, i) => [op, i] as const))('GET /v1/audit?op=%s returns exactly its row', async (op, i) => {
    const res = await fetch(`${handle.url}/v1/audit?op=${op}`);
    expect(res.status).toBe(200);
    // SAFETY: the route serializes AuditEvent[]; the assertions below check each field used.
    const body = (await res.json()) as Row[];
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      op,
      actor: ACTOR,
      targetId: `user-${i}`,
      metadata: { event: `ev-${i}`, active: op !== 'scim_user_delete', revokeKeys: op === 'scim_user_delete' },
    });
  });

  it.each([
    ['scim_user_delete', 'user-3'],
    ['scim_group_delete', 'user-7'],
  ] as const)('hippo audit list --op %s --json returns the delete row', async (op, targetId) => {
    const env = { ...process.env, HIPPO_HOME: home };
    const out = await runCliOut(['audit', 'list', '--op', op, '--json'], { env, cwd: base });
    // SAFETY: --json prints the AuditEvent[]; the assertions below check each field used.
    const rows = JSON.parse(out) as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ op, actor: ACTOR, targetId });
  });
});
