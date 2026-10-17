// `hippo reject` and `hippo invalidate` reach the trust and learn flows through src/api, as HTTP and MCP do.
import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { adminActor, ForbiddenError, invalidateMemories, rejectOnHost, remember } from '../../src/api/index.js';
import { readEntry } from '../../src/store/entry-reads.js';
import { handleInvalidate, handleReject } from '../../src/cli/curate.js';
import { listRejectionsForTenant } from '../../src/trust/reject-flow.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { apiCtx } from '../_helpers/api-ctx.js';

let root: string;
const cli = (tenantId = 'default'): FullContext => (apiCtx(root, tenantId, adminActor('cli')));

beforeEach(() => {
  root = makeRoot('cli-curate-api', { config: { embeddings: { enabled: false } } });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('the CLI curate verbs go through src/api', () => {
  it('hippo reject writes the tombstone under the api actor and removes the row', async () => {
    const id = (await remember(cli(), { content: 'the backup job runs on tuesdays at noon' })).id;
    const run = await runInProcess(() => handleReject({ hippoRoot: root, tenantId: 'default', args: [id], flags: { reason: 'wrong day' } }));
    expect(run.status).toBe(0);
    expect(readEntry(root, id, 'default')).toBeNull();
    expect((await listRejectionsForTenant(sqliteStore(root), 'default')).map((row) => row.rejectedBy)).toEqual([adminActor('cli').subject]);
  });

  it('hippo invalidate weakens the matching row through the api', async () => {
    const id = (await remember(cli(), { content: 'we deploy with jenkins pipelines' })).id;
    const run = await runInProcess(() => handleInvalidate({ hippoRoot: root, tenantId: 'default', args: ['jenkins'], flags: { reason: 'github actions' } }));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(id);
    expect(readEntry(root, id, 'default')?.confidence).toBe('stale');
  });

  it('rejectOnHost reports every removed row and refuses a caller who is not the host admin', async () => {
    const text = 'the nightly export runs at four in the morning';
    const id = (await remember(cli(), { content: text })).id;
    const result = await rejectOnHost(cli(), { memoryId: id, reason: 'wrong time' });
    expect(result).toMatchObject({ content: text, removedIds: [id], successorIds: [], dormantSuccessorIds: [] });
    expect(readEntry(root, id, 'default')).toBeNull();
    const member = apiCtx(root, 'default', { subject: 'api_key:hk_m', role: 'member' });
    await expect(rejectOnHost(member, { value: 'anything else', reason: 'x' })).rejects.toThrow(ForbiddenError);
  });

  it('rejectOnHost keeps the personal refusal for a personal row by id', async () => {
    const owner: FullContext = apiCtx(root, 'default', { subject: 'api_key:hk_a', role: 'member', owner: 'a' });
    const id = (await remember(owner, { content: 'my own reminder about the dentist', personal: true })).id;
    await expect(rejectOnHost(cli(), { memoryId: id, reason: 'x' })).rejects.toThrow("Personal memories can't be rejected. Use forget to remove it.");
  });

  it('invalidateMemories weakens only the context tenant', async () => {
    const here = (await remember(cli(), { content: 'we deploy with jenkins pipelines' })).id;
    const there = (await remember(cli('other'), { content: 'we deploy with jenkins pipelines' })).id;
    const result = invalidateMemories(cli(), { from: 'jenkins', to: 'github actions', type: 'migration' }, {});
    expect(result.targets).toEqual([here]);
    expect(readEntry(root, here, 'default')?.confidence).toBe('stale');
    expect(readEntry(root, there, 'other')?.confidence).not.toBe('stale');
  });
});
