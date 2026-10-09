// On a shared store getContext's task state keys on owner and project, so each developer gets their own, across sessions.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import { createApiKey } from '../src/store/auth.js';
import { getContext, type Context } from '../src/api/index.js';
import { BadRequestError } from '../src/core/api-errors.js';
import { _resetSharedStoreCacheForTests } from '../src/core/config.js';
import { promptHookContext } from '../src/api/prompt-hook.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { closeTaskSnapshotsForSession, saveActiveTaskSnapshot, type ContinuityKey } from '../src/store/sessions.js';
import { saveSessionHandoff } from '../src/store/handoffs.js';
import { serve, type ServerHandle } from '../src/server.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { makeRoot } from './_helpers/make-root.js';

const P = { name: 'p', legacyName: 'p' } as const;
const KEY_A: ContinuityKey = { owner: 'alice', project: ['p'] };
const KEY_B: ContinuityKey = { owner: 'bob', project: ['p'] };

let home: string;
let handle: ServerHandle | undefined;

const ctx = (owner: string): Context => ({ hippoRoot: home, tenantId: 'default', actor: { subject: `api_key:hk_${owner}`, role: 'member', owner } });

function snap(task: string, session: string) {
  return { task, summary: `${task} summary`, next_step: `${task} next`, session_id: session };
}

/** B's row first, then A's newer one: an unkeyed read would give A's row to both. */
function seedTwoOwners() {
  const b = saveActiveTaskSnapshot(home, 'default', snap('bob task', 'sb'), KEY_B).id;
  const a = saveActiveTaskSnapshot(home, 'default', snap('alice task', 'sa'), KEY_A).id;
  return { a, b };
}

function mintOwned(owner: string): string {
  const db = openHippoDb(home);
  try {
    return createApiKey(db, { tenantId: 'default', role: 'member', ownerSubject: owner }).plaintext;
  } finally {
    closeHippoDb(db);
  }
}

beforeEach(() => {
  _resetSharedStoreCacheForTests();
  home = makeRoot('context-task-owner', { config: { sharedStore: true } });
});

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
  _resetSharedStoreCacheForTests();
  rmSync(home, { recursive: true, force: true });
});

describe('task state on a shared store', () => {
  it('B saves its own snapshot first, A saves a newer one; B\'s context returns B\'s row id and never A\'s', async () => {
    const { a, b } = seedTwoOwners();
    expect((await getContext(ctx('bob'), { currentProject: P, currentSessionId: 'sb2' })).activeSnapshot?.id).toBe(b);
    expect((await getContext(ctx('alice'), { currentProject: P, currentSessionId: 'sa2' })).activeSnapshot?.id).toBe(a);
  });

  it('A\'s next session gets A\'s unfinished handoff', async () => {
    saveActiveTaskSnapshot(home, 'default', snap('alice task', 'sa1'), KEY_A);
    saveSessionHandoff(home, 'default', { version: 1, sessionId: 'sa1', summary: 'alice left off here' }, KEY_A);
    closeTaskSnapshotsForSession(home, 'default', 'sa1', 'session-ended', KEY_A);
    saveSessionHandoff(home, 'default', { version: 1, sessionId: 'sb1', summary: 'bob left off here' }, KEY_B);
    const forA = await getContext(ctx('alice'), { currentProject: P, currentSessionId: 'sa2' });
    expect(forA.activeSnapshot).toBeUndefined();
    expect(forA.sessionHandoff?.summary).toBe('alice left off here');
    expect((await getContext(ctx('bob'), { currentProject: P, currentSessionId: 'sb2' })).sessionHandoff?.summary).toBe('bob left off here');
  });

  it('no project gives no task state', async () => {
    const { a } = seedTwoOwners();
    expect((await getContext(ctx('alice'), { currentProject: P })).activeSnapshot?.id).toBe(a);
    await expect(getContext(ctx('alice'), { currentProject: { name: '', legacyName: '' } })).rejects.toBeInstanceOf(BadRequestError);
  });

  it('prompt hook context keyed the same way', async () => {
    writeEntry(home, { ...createMemory('PINNED: always check the rollback plan'), pinned: true, origin_project: 'p' });
    seedTwoOwners();
    const forB = await promptHookContext(ctx('bob'), { sessionId: 'sb2', project: P });
    expect(forB.stdout).toContain('bob task');
    expect(forB.stdout).not.toContain('alice task');
    expect((await promptHookContext(ctx('alice'), { sessionId: 'sa2', project: P })).stdout).toContain('alice task');
  });

  it('REST GET /v1/context with owned keys: A sees A\'s snapshot by id, B sees B\'s own by id, never A\'s', async () => {
    const { a, b } = seedTwoOwners();
    const keys = { alice: mintOwned('alice'), bob: mintOwned('bob') };
    handle = await serve({ hippoRoot: home, host: '127.0.0.1', port: 0 });
    const snapshotId = async (token: string): Promise<number | undefined> => {
      const res = await fetch(`${handle!.url}/v1/context?project=p`, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      // SAFETY: the route sends the whole ContextResult; only the snapshot id is read.
      return ((await res.json()) as { activeSnapshot?: { id: number } }).activeSnapshot?.id;
    };
    expect(await snapshotId(keys.alice)).toBe(a);
    expect(await snapshotId(keys.bob)).toBe(b);
  });
});
