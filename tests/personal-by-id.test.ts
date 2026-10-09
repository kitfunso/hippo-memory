// A by-id write on another person's personal row answers exactly as a missing id does (D6, F13), the owner still gets through, and no reject sweep reaches another person's row.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { listRejections, reject, remember, supersede, type Actor, type HippoDbContext } from '../src/api.js';
import { closeHippoDb, openHippoDb } from '../src/db.js';
import { insertDormantRow, readDormantSnapshot } from '../src/store/dormant.js';
import { mapApiError } from '../src/http-util.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, generateId, type MemoryKind } from '../src/memory.js';
import { handleMcpRequest, type McpContext, type McpResponse } from '../src/mcp/server.js';
import { rejectValue } from '../src/reject-flow.js';
import { readEntry } from '../src/store/entry-reads.js';
import { makeRoot } from './_helpers/make-root.js';

let root: string;
let globalRoot: string;

const actorA: Actor = { subject: 'api_key:hk_a', role: 'member', owner: 'a' };
const actorB: Actor = { subject: 'api_key:hk_b', role: 'member', owner: 'b' };
const unownedAdmin: Actor = { subject: 'api_key:hk_admin', role: 'admin' };
const outsiders: ReadonlyArray<[string, Actor]> = [['another owner', actorB], ['an unowned admin', unownedAdmin]];

type ByIdCall = () => void | Promise<McpResponse | null>;

function ctxFor(actor: Actor): HippoDbContext {
  return { hippoRoot: root, tenantId: 'default', actor };
}

function mcpCtxFor(actor: Actor): McpContext {
  const ctx: McpContext = { hippoRoot: root, tenantId: 'default', actor: actor.subject, role: actor.role };
  if (actor.owner !== undefined) ctx.owner = actor.owner;
  return ctx;
}

/** The HTTP status and message a refused call maps to, with `id` swapped for a placeholder so two ids compare. */
async function masked(id: string, call: ByIdCall): Promise<{ status: number; message: string }> {
  try {
    await call();
  } catch (err) {
    const { status, message } = mapApiError(err);
    return { status, message: message.replaceAll(id, '<id>') };
  }
  throw new Error('expected the call to be refused');
}

/** Asserts `actor` gets for `id` exactly what it gets for an id that was never stored. */
async function expectMissingIdAnswer(id: string, call: (target: string) => ReturnType<ByIdCall>): Promise<void> {
  const randomId = generateId('mem');
  const forRow = await masked(id, () => call(id));
  expect(forRow.status).toBe(404);
  expect(forRow).toEqual(await masked(randomId, () => call(randomId)));
}

function personalRow(kind: MemoryKind = 'distilled'): string {
  return remember(ctxFor(actorA), { content: `a's own note ${generateId('n')}`, personal: true, kind }).id;
}

beforeEach(() => {
  root = makeRoot('personal-by-id', { config: { embeddings: { enabled: false } } });
  globalRoot = makeRoot('personal-by-id-global');
  vi.stubEnv('HIPPO_HOME', globalRoot);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  rmSync(globalRoot, { recursive: true, force: true });
});

describe('by-id writes on someone else\'s personal row', () => {
  it('supersede by the owner keeps the successor in the owner\'s scope with origin \'\'', () => {
    const id = personalRow();
    const { newId } = supersede(ctxFor(actorA), id, 'a newer version of the note');
    const successor = readEntry(root, newId, 'default');
    expect(successor?.scope).toBe('personal:private:a');
    expect(successor?.origin_project).toBe('');
  });

  it('hippo_share: another owner and an unowned admin get the missing-id error, while a team row still shares', async () => {
    const id = personalRow();
    const share = (actor: Actor, target: string): Promise<McpResponse | null> => handleMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hippo_share', arguments: { id: target, force: true } } },
      mcpCtxFor(actor),
    );
    for (const [, actor] of outsiders) {
      await expectMissingIdAnswer(id, (target) => share(actor, target));
    }
    const team = remember(ctxFor(actorB), { content: 'always pin the node version in CI' });
    expect(JSON.stringify(await share(actorB, team.id))).toContain('Shared [');
  });
});

describe('reject next to personal rows', () => {
  const SHARED_TEXT = 'the staging cluster restarts every friday at noon';
  const PERSONAL_REFUSAL = "Personal memories can't be rejected. Use forget to remove it.";

  it('reject by id: another owner and an unowned admin get the missing-id 404, the owner and the CLI get a 400, and no tombstone is made', async () => {
    const id = personalRow();
    for (const [, actor] of outsiders) {
      await expectMissingIdAnswer(id, (target) => { reject(ctxFor(actor), { memoryId: target, reason: 'wrong' }); });
    }
    expect(await masked(id, () => { reject(ctxFor(actorA), { memoryId: id, reason: 'wrong' }); })).toEqual({ status: 400, message: PERSONAL_REFUSAL });
    expect(() => rejectValue({ hippoRoot: root, tenantId: 'default', actor: 'cli', reason: 'wrong', memoryId: id })).toThrow(PERSONAL_REFUSAL);
    expect(listRejections(ctxFor(actorA))).toHaveLength(0);
    expect(readEntry(root, id, 'default')?.scope).toBe('personal:private:a');
  });

  it('reject by value removes team copies and the caller\'s own personal copy, never another person\'s', () => {
    const mineA = remember(ctxFor(actorA), { content: SHARED_TEXT, personal: true }).id;
    const mineB = remember(ctxFor(actorB), { content: SHARED_TEXT, personal: true }).id;
    const team = remember(ctxFor(actorB), { content: SHARED_TEXT }).id;
    const { removedIds } = reject(ctxFor(actorB), { value: SHARED_TEXT, reason: 'stale' });
    expect([...removedIds].sort()).toEqual([mineB, team].sort());
    expect(readEntry(root, mineA, 'default')?.scope).toBe('personal:private:a');
    expect(readEntry(root, mineB, 'default')).toBeNull();
    expect(readEntry(root, team, 'default')).toBeNull();
  });

  it('the CLI reject by value, which has no owner, leaves every personal row', () => {
    const mineA = remember(ctxFor(actorA), { content: SHARED_TEXT, personal: true }).id;
    const team = remember(ctxFor(actorB), { content: SHARED_TEXT }).id;
    const { removedIds } = rejectValue({ hippoRoot: root, tenantId: 'default', actor: 'cli', reason: 'stale', value: SHARED_TEXT });
    expect(removedIds).toEqual([team]);
    expect(readEntry(root, mineA, 'default')?.scope).toBe('personal:private:a');
  });

  it('reject by value leaves another person\'s dormant personal copy and removes a dormant team copy', () => {
    const personal = createMemory(SHARED_TEXT, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, scope: 'personal:private:a' });
    const team = createMemory(SHARED_TEXT, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    const db = openHippoDb(root);
    try {
      for (const entry of [personal, team]) insertDormantRow(db, { entry, strength: 0.01, reason: 'decay', dormantAt: new Date().toISOString() });
    } finally {
      closeHippoDb(db);
    }
    expect(reject(ctxFor(actorB), { value: SHARED_TEXT, reason: 'stale' }).removedIds).toEqual([team.id]);
    const after = openHippoDb(root);
    try {
      expect(readDormantSnapshot(after, 'default', personal.id)?.entry.scope).toBe('personal:private:a');
      expect(readDormantSnapshot(after, 'default', team.id)).toBeNull();
    } finally {
      closeHippoDb(after);
    }
  });
});
