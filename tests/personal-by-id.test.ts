// A by-id write on another person's personal row answers exactly as a missing id does (D6, F13), and the owner still gets through.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { archiveRaw, forget, listRejections, outcome, promote, reject, remember, supersede, type Actor, type Context } from '../src/api.js';
import { mapApiError } from '../src/http-util.js';
import { generateId, type MemoryKind } from '../src/memory.js';
import { handleMcpRequest, type McpContext, type McpResponse } from '../src/mcp/server.js';
import { readEntry } from '../src/store/entry-reads.js';
import { makeRoot } from './_helpers/make-root.js';

let root: string;
let globalRoot: string;

const actorA: Actor = { subject: 'api_key:hk_a', role: 'member', owner: 'a' };
const actorB: Actor = { subject: 'api_key:hk_b', role: 'member', owner: 'b' };
const unownedAdmin: Actor = { subject: 'api_key:hk_admin', role: 'admin' };
const outsiders: ReadonlyArray<[string, Actor]> = [['another owner', actorB], ['an unowned admin', unownedAdmin]];

type ByIdCall = () => void | Promise<McpResponse | null>;

function ctxFor(actor: Actor): Context {
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
  const ownerWrites: ReadonlyArray<[string, MemoryKind, (ctx: Context, id: string) => void]> = [
    ['forget', 'distilled', (ctx, id) => { forget(ctx, id); }],
    ['reject', 'distilled', (ctx, id) => { reject(ctx, { memoryId: id, reason: 'wrong' }); }],
    ['archive', 'raw', (ctx, id) => { archiveRaw(ctx, id, 'cleanup'); }],
    ['supersede', 'distilled', (ctx, id) => { supersede(ctx, id, 'a newer version of the note'); }],
  ];

  it.each(ownerWrites)('%s: another owner and an unowned admin get the missing-id 404, and the owner succeeds', async (_op, kind, write) => {
    const id = personalRow(kind);
    for (const [, actor] of outsiders) {
      await expectMissingIdAnswer(id, (target) => write(ctxFor(actor), target));
    }
    const untouched = readEntry(root, id, 'default');
    expect(untouched?.scope).toBe('personal:private:a');
    expect(untouched?.superseded_by ?? null).toBeNull();
    expect(listRejections(ctxFor(actorA))).toHaveLength(0);

    write(ctxFor(actorA), id);
    const after = readEntry(root, id, 'default');
    expect(after === null || after.superseded_by !== null).toBe(true);
  });

  it('supersede by the owner keeps the successor in the owner\'s scope with origin \'\'', () => {
    const id = personalRow();
    const { newId } = supersede(ctxFor(actorA), id, 'a newer version of the note');
    const successor = readEntry(root, newId, 'default');
    expect(successor?.scope).toBe('personal:private:a');
    expect(successor?.origin_project).toBe('');
  });

  it('promote: another owner and an unowned admin get the missing-id 404, while a team row still promotes', async () => {
    const id = personalRow();
    for (const [, actor] of outsiders) {
      await expectMissingIdAnswer(id, (target) => { promote(ctxFor(actor), target); });
    }
    const team = remember(ctxFor(actorB), { content: 'the team build runs on node 22' });
    expect(promote(ctxFor(actorB), team.id).ok).toBe(true);
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

  it('outcome skips the row for another owner and an unowned admin, and applies for the owner', () => {
    const id = personalRow();
    for (const [, actor] of outsiders) {
      expect(outcome(ctxFor(actor), [id], false)).toEqual({ applied: 0, appliedIds: [] });
    }
    expect(readEntry(root, id, 'default')?.outcome_negative ?? 0).toBe(0);
    expect(outcome(ctxFor(actorA), [id], false)).toEqual({ applied: 1, appliedIds: [id] });
    expect(readEntry(root, id, 'default')?.outcome_negative).toBe(1);
  });
});
