// Promote and share refuse a granted member without a trace and answer an unreachable row as a missing id. Real stores.
// The owner, admin and audit cells of the same rule live in the member-grant sweep, over HTTP and MCP.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { createMemory } from '../../src/entry/memory.js';
import type { MemoryEntry } from '../../src/base/memory/entry.js';
import type { Actor } from '../../src/api/types.js';
import { promote } from '../../src/api/memories/promote.js';
import { ForbiddenError, memoryNotFoundText, NotFoundError } from '../../src/base/errors/api-errors.js';
import { shareMemory } from '../../src/domain/sharing/share.js';
import { getGlobalRoot } from '../../src/host/global-store.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries, writeEntry } from '../_helpers/root-forms.js';
import { sharingStores } from '../_helpers/sharing-stores.js';
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
const GRANTED = member('api_key:granted', 'oid-m', [S]);
const UNGRANTED = member('api_key:none', 'oid-n', []);

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

  it('copies nothing when a granted member who did not write the row is refused, over promote and share', async () => {
    await expect(promote(apiCtx(root, 'default', GRANTED), row.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(share(GRANTED)).rejects.toBeInstanceOf(ForbiddenError);
    expect(globalRows()).toEqual([]);
  });

  it('answers a member with no grant as it answers a missing id', async () => {
    await expect(share(UNGRANTED, 'mem_absent')).rejects.toThrow(memoryNotFoundText('mem_absent'));
    await expect(share(UNGRANTED)).rejects.toThrow(memoryNotFoundText(row.id));
    await expect(share(UNGRANTED)).rejects.toBeInstanceOf(NotFoundError);
    await expect(promote(apiCtx(root, 'default', UNGRANTED), row.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});
