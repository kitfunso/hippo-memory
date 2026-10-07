// Conflict resolution never reaches another person's personal row, and a personal value never becomes a tenant-wide tombstone (F1).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { listRejections, remember, type Actor, type Context } from '../src/api.js';
import { resolveOpenConflict } from '../src/dashboard-actions.js';
import { mapApiError } from '../src/http-util.js';
import { handleMcpRequest, type McpContext, type McpResponse } from '../src/mcp/server.js';
import { listMemoryConflicts, replaceDetectedConflicts } from '../src/store/conflicts.js';
import { readEntry } from '../src/store/entry-reads.js';
import { makeRoot } from './_helpers/make-root.js';

const A_TEXT = 'always run the deploy script with --dry-run first';
const NOT_RESOLVED = 'Could not resolve. Check the conflict ID and --keep value.';

let root: string;

const actorA: Actor = { subject: 'api_key:hk_a', role: 'member', owner: 'a' };
const actorB: Actor = { subject: 'api_key:hk_b', role: 'member', owner: 'b' };
const unownedAdmin: Actor = { subject: 'api_key:hk_admin', role: 'admin' };

function ctxFor(actor: Actor): Context {
  return { hippoRoot: root, tenantId: 'default', actor };
}

async function callTool(actor: Actor, name: string, args: Record<string, string | number | boolean>): Promise<McpResponse | null> {
  const ctx: McpContext = { hippoRoot: root, tenantId: 'default', actor: actor.subject, role: actor.role };
  if (actor.owner !== undefined) ctx.owner = actor.owner;
  return handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, ctx);
}

function replyText(res: McpResponse | null): string {
  // SAFETY: every hippo_* tool answers the MCP tool-call result shape { content: [{ text }] }.
  const result = res?.result as { content?: Array<{ text?: string }> } | undefined;
  return result?.content?.[0]?.text ?? '';
}

/** Seeds one open conflict per pair, replacing any before, and returns their ids; each pair's first id must be in no other pair. */
function seedConflicts(...pairs: ReadonlyArray<readonly [string, string]>): number[] {
  replaceDetectedConflicts(root, pairs.map(([a, b]) => ({ memory_a_id: a, memory_b_id: b, reason: 'contradictory deploy advice', score: 0.9 })));
  const open = listMemoryConflicts(root, 'open', 'default');
  return pairs.map(([a]) => {
    const conflict = open.find((c) => [c.memory_a_id, c.memory_b_id].includes(a));
    if (!conflict) throw new Error('seeded conflict not found');
    return conflict.id;
  });
}

const seedConflict = (aId: string, bId: string): number => seedConflicts([aId, bId])[0]!;

interface PersonalPair {
  personalId: string;
  teamId: string;
  conflictId: number;
}

/** A's personal row in an open conflict with B's team row. */
function personalPair(): PersonalPair {
  const personalId = remember(ctxFor(actorA), { content: A_TEXT, personal: true }).id;
  const teamId = remember(ctxFor(actorB), { content: 'never run the deploy script with --dry-run' }).id;
  return { personalId, teamId, conflictId: seedConflict(personalId, teamId) };
}

beforeEach(() => {
  root = makeRoot('resolve-personal', { config: { embeddings: { enabled: false } } });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolving conflicts next to personal rows', () => {
  it('rejectLoser on a team row sweeps team duplicates but leaves another person\'s personal row holding the same text', async () => {
    const personalId = remember(ctxFor(actorA), { content: A_TEXT, personal: true }).id;
    const teamCopy = remember(ctxFor(actorB), { content: A_TEXT }).id;
    const loser = remember(ctxFor(actorB), { content: A_TEXT }).id;
    const keeper = remember(ctxFor(actorB), { content: 'never run the deploy script with --dry-run' }).id;
    expect(new Set([personalId, teamCopy, loser]).size).toBe(3);
    const conflictId = seedConflict(keeper, loser);

    const reply = await callTool(actorB, 'hippo_resolve', { conflict_id: conflictId, keep: keeper, rejectLoser: true });
    expect(replyText(reply)).toContain(`Resolved conflict ${conflictId}`);
    expect(readEntry(root, loser, 'default')).toBeNull();
    expect(readEntry(root, teamCopy, 'default')).toBeNull();
    expect(readEntry(root, personalId, 'default')?.scope).toBe('personal:private:a');
    const tombstones = listRejections(ctxFor(actorB));
    expect(tombstones.map((r) => r.sourceMemoryId)).toEqual([loser]);
  });

  it('rejectLoser on the owner\'s own personal loser is a 400 that changes nothing, while forget resolves it', async () => {
    const { personalId, teamId, conflictId } = personalPair();
    let refusal: { status: number; message: string } | undefined;
    try {
      await callTool(actorA, 'hippo_resolve', { conflict_id: conflictId, keep: teamId, rejectLoser: true });
    } catch (err) {
      refusal = mapApiError(err);
    }
    expect(refusal?.status).toBe(400);
    expect(refusal?.message).toContain('cannot reject the value of personal memory');
    expect(listRejections(ctxFor(actorA))).toHaveLength(0);
    expect(readEntry(root, personalId, 'default')).not.toBeNull();
    expect(listMemoryConflicts(root, 'open', 'default').map((c) => c.id)).toEqual([conflictId]);

    const forgotten = await callTool(actorA, 'hippo_resolve', { conflict_id: conflictId, keep: teamId, forget: true });
    expect(replyText(forgotten)).toContain(`Resolved conflict ${conflictId}`);
    expect(readEntry(root, personalId, 'default')).toBeNull();
  });

  it('hippo_conflicts hides a pair holding someone else\'s personal row, and the owner sees it', async () => {
    const { personalId, teamId } = personalPair();
    const otherTeamId = remember(ctxFor(actorB), { content: 'always run the deploy script from the repo root' }).id;
    const [conflictId, teamConflictId] = seedConflicts([personalId, teamId], [otherTeamId, teamId]);
    const listed = replyText(await callTool(actorA, 'hippo_conflicts', {}));
    expect(listed).toContain(`conflict_${conflictId}:`);
    expect(listed).toContain(`conflict_${teamConflictId}:`);
    for (const outsider of [actorB, unownedAdmin]) {
      const seen = replyText(await callTool(outsider, 'hippo_conflicts', {}));
      expect(seen).toContain(`conflict_${teamConflictId}:`);
      expect(seen).not.toContain(`conflict_${conflictId}:`);
    }
  });

  it('hippo_resolve on a pair holding someone else\'s personal row answers as a missing conflict does, and the owner resolves it', async () => {
    const { personalId, teamId, conflictId } = personalPair();
    for (const outsider of [actorB, unownedAdmin]) {
      expect(replyText(await callTool(outsider, 'hippo_resolve', { conflict_id: conflictId, keep: teamId, forget: true }))).toBe(NOT_RESOLVED);
      expect(replyText(await callTool(outsider, 'hippo_resolve', { conflict_id: conflictId + 1000, keep: teamId, forget: true }))).toBe(NOT_RESOLVED);
    }
    expect(readEntry(root, personalId, 'default')).not.toBeNull();
    expect(listMemoryConflicts(root, 'open', 'default').map((c) => c.id)).toEqual([conflictId]);

    const resolved = await callTool(actorA, 'hippo_resolve', { conflict_id: conflictId, keep: personalId });
    expect(replyText(resolved)).toBe(`Resolved conflict ${conflictId}: kept ${personalId}, weakened ${teamId}`);
  });

  it('the dashboard resolve answers a pair holding a personal row as it answers a missing conflict, open or resolved', async () => {
    const { personalId, teamId, conflictId } = personalPair();
    const missing = resolveOpenConflict(root, 'default', conflictId + 1000, { keep: teamId });
    expect(missing.status).toBe(404);
    expect(resolveOpenConflict(root, 'default', conflictId, { keep: teamId })).toEqual(missing);
    expect(listMemoryConflicts(root, 'open', 'default').map((c) => c.id)).toEqual([conflictId]);

    await callTool(actorA, 'hippo_resolve', { conflict_id: conflictId, keep: personalId });
    expect(resolveOpenConflict(root, 'default', conflictId, { keep: teamId })).toEqual(missing);
  });
});
