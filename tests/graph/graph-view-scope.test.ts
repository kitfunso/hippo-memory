// E10 lane A: buildGraphModel hides graph rows whose source memory the caller may not read. Real SQLite, no mocks.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemory, Layer, type MemoryEntry, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { insertEntityAt, insertRelationAt } from '../_helpers/graph-seed.js';
import { savePolicy } from '../../src/domain/objects/policies.js';
import { buildGraphModel } from '../../src/domain/graph/view.js';
import type { ScopeActor } from '../../src/base/scope/recall-scope.js';
import { makeRoot } from '../_helpers/make-root.js';
import { objectsAt } from '../_helpers/objects-at.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { loadConfig } from '../../src/base/config/config.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { oneRequestPerTest, removeAfterRequest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

const T = 'default';
const OWN_A = 'personal:private:alice';

function mem(home: string, text: string, scope: string | null): MemoryEntry {
  const m = createMemory(text, {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    tags: [],
    layer: Layer.Semantic,
    confidence: 'verified',
    source: 'test',
    tenantId: T,
    scope,
  });
  writeEntry(home, m, { actor: 'test' });
  return m;
}

const names = (m: { nodes: { name: string }[] }): string[] => m.nodes.map((n) => n.name).sort();

describe('graph-view personal scope', () => {
  let home: string;
  const alice: ScopeActor = { role: 'member', owner: 'alice' };
  const bob: ScopeActor = { role: 'member', owner: 'bob' };

  beforeEach(async () => {
    home = makeRoot('graphview-scope');
    const team = mem(home, 'team decision about deploy windows', null);
    const priv = mem(home, 'alice private note about deploy windows', OWN_A);
    const eTeam = insertEntityAt(home, T, { entityType: 'decision', name: 'TEAM', memoryId: team.id }).id;
    const ePriv = insertEntityAt(home, T, { entityType: 'decision', name: 'PRIV-A', memoryId: priv.id }).id;
    // A team-sourced edge into A's entity must still go when its endpoint goes.
    insertRelationAt(home, T, { fromEntityId: eTeam, toEntityId: ePriv, relType: 'references', memoryId: team.id });
    const policy = await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      policyName: 'Anchored',
      policyText: 'kept by its object',
    });
    insertEntityAt(home, T, {
      entityType: 'policy',
      name: 'ANCHORED',
      memoryId: null,
      sourceObject: { type: 'policy', id: policy.id },
    });
  });
  afterEach(() => {
    try {
      removeAfterRequest(home);
    } catch {
      /* best-effort */
    }
  });

  it('A sees its own entity and the edge to it; B sees neither; a NULL-memory entity stays for both', async () => {
    const a = await buildGraphModel(sqliteStore(home).graphReads, T, { reader: alice });
    expect(names(a)).toEqual(['ANCHORED', 'PRIV-A', 'TEAM']);
    expect(a.edges).toHaveLength(1);

    const b = await buildGraphModel(sqliteStore(home).graphReads, T, { reader: bob });
    expect(names(b)).toEqual(['ANCHORED', 'TEAM']);
    expect(b.edges).toHaveLength(0);
  });

  it('focus on a hidden name is empty for B, and B focusing a neighbour does not reach it', async () => {
    const a = await buildGraphModel(sqliteStore(home).graphReads, T, { entity: 'PRIV-A', reader: alice });
    expect(names(a)).toEqual(['PRIV-A', 'TEAM']);
    expect(a.edges).toHaveLength(1);

    expect(await buildGraphModel(sqliteStore(home).graphReads, T, { entity: 'PRIV-A', reader: bob })).toEqual({
      nodes: [],
      edges: [],
      truncated: false,
    });
    const viaTeam = await buildGraphModel(sqliteStore(home).graphReads, T, { entity: 'TEAM', reader: bob });
    expect(names(viaTeam)).toEqual(['TEAM']);
    expect(viaTeam.edges).toHaveLength(0);
  });
});
