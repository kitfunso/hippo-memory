// The api reads behind the MCP admin tools: status counts, open conflicts and the personal-row guard.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { remember, listOpenConflicts, type Actor, type HippoDbContext } from '../src/api/index.js';
import { getMemoryStatus, getTouchableMemory } from '../src/api/memories.js';
import { NotFoundError } from '../src/core/api-errors.js';
import { replaceDetectedConflicts } from '../src/store/conflicts.js';
import { makeRoot } from './_helpers/make-root.js';

let root: string;
const actorA: Actor = { subject: 'api_key:hk_a', role: 'member', owner: 'a' };
const actorB: Actor = { subject: 'api_key:hk_b', role: 'member', owner: 'b' };
const ctxFor = (actor: Actor): HippoDbContext => ({ hippoRoot: root, tenantId: 'default', actor });

beforeEach(() => {
  root = makeRoot('api-admin-reads', { config: { embeddings: { enabled: false } } });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('api admin reads', () => {
  it('counts memories and open conflicts, hides a personal pair from another person, and refuses their personal row', async () => {
    const personal = remember(ctxFor(actorA), { content: 'deploy with --dry-run first', personal: true }).id;
    const team = remember(ctxFor(actorB), { content: 'deploy without --dry-run' }).id;
    replaceDetectedConflicts(root, [{ memory_a_id: personal, memory_b_id: team, reason: 'contradiction', score: 0.9 }]);

    const status = getMemoryStatus(ctxFor(actorA), new Date(), 0.1);
    expect(status.total).toBe(2);
    expect(status.openConflicts).toBe(1);
    expect(listOpenConflicts(ctxFor(actorA))).toHaveLength(1);
    expect(listOpenConflicts(ctxFor(actorB))).toHaveLength(0);
    await expect(getTouchableMemory(ctxFor(actorB), personal)).rejects.toBeInstanceOf(NotFoundError);
    expect((await getTouchableMemory(ctxFor(actorA), personal))?.id).toBe(personal);
  });
});
