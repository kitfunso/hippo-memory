// E10 lane A: buildGraphModel hides graph rows whose source memory the caller may not read. Real SQLite, no mocks.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory, Layer, type MemoryEntry, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { insertEntity, insertRelation } from '../src/graph/write.js';
import { savePolicy } from '../src/policies.js';
import { buildGraphModel } from '../src/graph-view.js';
import { canReadScope } from '../src/recall-scope.js';
import { makeRoot } from './_helpers/make-root.js';

const T = 'default';
const OWN_A = 'personal:private:alice';

function mem(home: string, text: string, scope: string | null): MemoryEntry {
  const m = createMemory(text, {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    tags: [], layer: Layer.Semantic, confidence: 'verified', source: 'test',
    tenantId: T, scope,
  });
  writeEntry(home, m, { actor: 'test' });
  return m;
}

function readerFor(owner: string): (scope: string | null) => boolean {
  return (scope) => scope === null || canReadScope({ role: 'member', owner }, scope);
}

const names = (m: { nodes: { name: string }[] }): string[] => m.nodes.map((n) => n.name).sort();

describe('graph-view personal scope (E10 lane A)', () => {
  let home: string;
  const alice = readerFor('alice');
  const bob = readerFor('bob');

  beforeEach(() => {
    home = makeRoot('graphview-scope');
    const team = mem(home, 'team decision about deploy windows', null);
    const priv = mem(home, 'alice private note about deploy windows', OWN_A);
    const eTeam = insertEntity(home, T, { entityType: 'decision', name: 'TEAM', memoryId: team.id }).id;
    const ePriv = insertEntity(home, T, { entityType: 'decision', name: 'PRIV-A', memoryId: priv.id }).id;
    // A team-sourced edge into A's entity must still go when its endpoint goes.
    insertRelation(home, T, { fromEntityId: eTeam, toEntityId: ePriv, relType: 'references', memoryId: team.id });
    const policy = savePolicy(home, T, { policyName: 'Anchored', policyText: 'kept by its object' });
    insertEntity(home, T, { entityType: 'policy', name: 'ANCHORED', memoryId: null, sourceObject: { type: 'policy', id: policy.id } });
  });
  afterEach(() => { try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ } });

  it('A sees its own entity and the edge to it; B sees neither', () => {
    const a = buildGraphModel(home, T, { canRead: alice });
    expect(names(a)).toEqual(['ANCHORED', 'PRIV-A', 'TEAM']);
    expect(a.edges).toHaveLength(1);

    const b = buildGraphModel(home, T, { canRead: bob });
    expect(names(b)).toEqual(['ANCHORED', 'TEAM']);
    expect(b.edges).toHaveLength(0);
  });

  it('a NULL-memory entity has no scope to hide and stays for both', () => {
    expect(names(buildGraphModel(home, T, { canRead: alice }))).toContain('ANCHORED');
    expect(names(buildGraphModel(home, T, { canRead: bob }))).toContain('ANCHORED');
  });

  it('focus on a hidden name is empty for B, and B focusing a neighbour does not reach it', () => {
    const a = buildGraphModel(home, T, { entity: 'PRIV-A', canRead: alice });
    expect(names(a)).toEqual(['PRIV-A', 'TEAM']);
    expect(a.edges).toHaveLength(1);

    expect(buildGraphModel(home, T, { entity: 'PRIV-A', canRead: bob })).toEqual({ nodes: [], edges: [], truncated: false });
    const viaTeam = buildGraphModel(home, T, { entity: 'TEAM', canRead: bob });
    expect(names(viaTeam)).toEqual(['TEAM']);
    expect(viaTeam.edges).toHaveLength(0);
  });
});
