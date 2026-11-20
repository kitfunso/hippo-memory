// Promote and share copy a restricted row only for an admin or its owner; a read grant is not enough. Real stores.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { createMemory } from '../../src/entry/memory.js';
import type { MemoryEntry } from '../../src/base/memory/entry.js';
import type { Actor } from '../../src/api/types.js';
import { promote } from '../../src/api/memories/promote.js';
import { ForbiddenError, NotFoundError } from '../../src/base/errors/api-errors.js';
import { shareMemory } from '../../src/domain/sharing/share.js';
import { getGlobalRoot } from '../../src/host/global-store.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { listAuditEvents } from '../../src/store/sqlite/audit/audit.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries, writeEntry } from '../_helpers/root-forms.js';
import { sharedEntry, sharingStores } from '../_helpers/sharing-stores.js';
import { initTestStore } from '../_helpers/store-template.js';
import { TEST_DETACHED, TEST_RUN } from '../_helpers/test-run.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const S = 'slack:private:c1';
const TEXT = 'gotcha: the staging vpn drops idle sessions after ten minutes, reconnect first';

const member = (subject: string, owner: string, scopes: readonly string[]): Actor => ({
  subject,
  role: 'member',
  owner,
  scopes,
});
const OWNER = member('api_key:owner', 'oid-o', [S]);
const GRANTED = member('api_key:granted', 'oid-m', [S]);
const UNGRANTED = member('api_key:none', 'oid-n', []);
const ADMIN: Actor = { subject: 'api_key:admin', role: 'admin' };

describe('promote and share on a restricted row', () => {
  let root: string;
  let row: MemoryEntry;

  beforeEach(() => {
    const tmp = makeRoot('copy-out-grants', { init: false });
    root = join(tmp, 'proj', '.hippo');
    initTestStore(root);
    vi.stubEnv('HIPPO_HOME', join(tmp, 'global'));
    row = createMemory(TEXT, { tenantId: 'default', scope: S, owner: 'oid-o', tags: ['error'] });
    writeEntry(root, row);
  });

  const share = (actor: Actor, id = row.id) =>
    shareMemory(...sharingStores(root), id, {
      actor,
      embed: TEST_RUN,
      detached: TEST_DETACHED,
      tenantId: 'default',
    });
  const globalRows = () => loadAllEntries(getGlobalRoot(), 'default');

  it('refuses a granted member who did not write the row, over promote and share, and copies nothing', async () => {
    await expect(promote(apiCtx(root, 'default', GRANTED), row.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(share(GRANTED)).rejects.toBeInstanceOf(ForbiddenError);
    expect(globalRows()).toEqual([]);
  });

  it('answers a member with no grant as it answers a missing id', async () => {
    await expect(share(UNGRANTED, 'mem_absent')).rejects.toThrow('Memory not found: mem_absent');
    await expect(share(UNGRANTED)).rejects.toThrow(`Memory not found: ${row.id}`);
    await expect(share(UNGRANTED)).rejects.toBeInstanceOf(NotFoundError);
    await expect(promote(apiCtx(root, 'default', UNGRANTED), row.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('lets the owner and an admin copy it', async () => {
    expect(sharedEntry(await share(OWNER)).scope).toBe(S);
    expect((await promote(apiCtx(root, 'default', ADMIN), row.id)).ok).toBe(true);
  });

  it("names the sharing caller in the global row's remember audit event, not the CLI", async () => {
    await share(OWNER);
    const db = openHippoDb(getGlobalRoot());
    try {
      const actors = listAuditEvents(db, { tenantId: 'default', op: 'remember' }).map((e) => e.actor);
      expect(actors).toEqual(['api_key:owner']);
    } finally {
      closeHippoDb(db);
    }
  });
});
