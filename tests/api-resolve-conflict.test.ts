// MCP and the CLI resolve a conflict through one api function, so each refuses the same bad input the dashboard refuses.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { adminActor, ConflictError, NotFoundError, resolveMemoryConflict, type HippoDbContext } from '../src/api/index.js';
import { handleResolve } from '../src/cli/curate.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, type MemoryEntry } from '../src/core/memory.js';
import { handleMcpRequest, type McpResponse } from '../src/mcp/server.js';
import { listMemoryConflicts, replaceDetectedConflicts } from '../src/store/conflicts.js';
import { readEntry } from '../src/store/entry-reads.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { makeRoot } from './_helpers/make-root.js';
import { runInProcess } from './_helpers/run-in-process.js';

const TENANT = 'default';
const NOT_RESOLVED = 'Could not resolve. Check the conflict ID and --keep value.';

let root: string;

beforeEach(() => {
  root = makeRoot('api-resolve-conflict', { config: { embeddings: { enabled: false } } });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Pair {
  a: MemoryEntry;
  b: MemoryEntry;
  conflictId: number;
}

function seedPair(): Pair {
  const a = createMemory('deploys run from the main branch', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tenantId: TENANT });
  const b = createMemory('deploys never run from the main branch', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tenantId: TENANT });
  writeEntry(root, a);
  writeEntry(root, b);
  replaceDetectedConflicts(root, [{ memory_a_id: a.id, memory_b_id: b.id, reason: 'contradictory deploy advice', score: 0.9 }]);
  const [conflict] = listMemoryConflicts(root, 'open', TENANT);
  if (!conflict) throw new Error('seeded conflict not found');
  return { a, b, conflictId: conflict.id };
}

/** `b` superseded by a fresh row, so the pair no longer holds two live memories. */
function supersedeB({ b }: Pair): void {
  const successor = createMemory('deploys run from a release branch', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tenantId: TENANT });
  writeEntry(root, successor);
  writeEntry(root, { ...b, superseded_by: successor.id, kind: 'superseded' });
}

async function mcpResolve(args: Record<string, string | number | boolean>): Promise<McpResponse | null> {
  return handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hippo_resolve', arguments: args } }, { hippoRoot: root, tenantId: TENANT, actor: 'tester' });
}

function replyText(res: McpResponse | null): string {
  // SAFETY: hippo_resolve answers the MCP tool-call result shape { content: [{ text }] }.
  const result = res?.result as { content?: Array<{ text?: string }> } | undefined;
  return result?.content?.[0]?.text ?? '';
}

function cliResolve(conflictId: number, flags: Record<string, string | boolean>): ReturnType<typeof runInProcess> {
  return runInProcess(() => handleResolve({ hippoRoot: root, tenantId: TENANT, args: [String(conflictId)], flags }));
}

const openIds = (): number[] => listMemoryConflicts(root, 'open', TENANT).map((c) => c.id);

describe('MCP hippo_resolve', () => {
  it('keeps its reply for a valid resolve', async () => {
    const pair = seedPair();
    const reply = await mcpResolve({ conflict_id: pair.conflictId, keep: pair.a.id });
    expect(replyText(reply)).toBe(`Resolved conflict ${pair.conflictId}: kept ${pair.a.id}, weakened ${pair.b.id}`);
    expect(openIds()).toEqual([]);
  });

  it('refuses a pair whose member is superseded, as the dashboard does', async () => {
    const pair = seedPair();
    supersedeB(pair);
    expect(replyText(await mcpResolve({ conflict_id: pair.conflictId, keep: pair.a.id, forget: true }))).toBe(NOT_RESOLVED);
    expect(openIds()).toEqual([pair.conflictId]);
    expect(readEntry(root, pair.b.id, TENANT)?.half_life_days).toBe(pair.b.half_life_days);
  });

  it('refuses a keep id outside the pair with a message naming the pair', async () => {
    const pair = seedPair();
    await expect(mcpResolve({ conflict_id: pair.conflictId, keep: 'mem_elsewhere' })).rejects.toThrow(`keep must be one of the two memories in conflict ${pair.conflictId}`);
    expect(openIds()).toEqual([pair.conflictId]);
  });
});

describe('CLI hippo resolve', () => {
  it('keeps its output for a valid resolve', async () => {
    const pair = seedPair();
    const run = await cliResolve(pair.conflictId, { keep: pair.a.id });
    expect(run.stdout).toBe(`Resolved conflict ${pair.conflictId}: kept ${pair.a.id}, weakened (half-life halved) ${pair.b.id}\n`);
    expect(openIds()).toEqual([]);
  });

  it('refuses a pair whose member is superseded, as the dashboard does', async () => {
    const pair = seedPair();
    supersedeB(pair);
    await expect(cliResolve(pair.conflictId, { keep: pair.a.id, forget: true })).rejects.toThrow(NotFoundError);
    expect(openIds()).toEqual([pair.conflictId]);
    expect(readEntry(root, pair.b.id, TENANT)).not.toBeNull();
  });

  it('refuses a keep id outside the pair, as the dashboard does', async () => {
    const pair = seedPair();
    await expect(cliResolve(pair.conflictId, { keep: 'mem_elsewhere' })).rejects.toThrow(`keep must be one of the two memories in conflict ${pair.conflictId}`);
    expect(openIds()).toEqual([pair.conflictId]);
  });
});

describe('resolveMemoryConflict', () => {
  const ctxIn = (tenantId: string): HippoDbContext => ({ hippoRoot: root, tenantId, actor: adminActor('test') });

  it('answers a resolved conflict with 409 and another tenant\'s with 404', () => {
    const pair = seedPair();
    expect(() => resolveMemoryConflict(ctxIn('acme'), pair.conflictId, { keepId: pair.a.id })).toThrow(NotFoundError);
    expect(resolveMemoryConflict(ctxIn(TENANT), pair.conflictId, { keepId: pair.a.id })).toEqual({ conflictId: pair.conflictId, keptId: pair.a.id, loserId: pair.b.id });
    expect(() => resolveMemoryConflict(ctxIn(TENANT), pair.conflictId, { keepId: pair.a.id })).toThrow(ConflictError);
  });
});
