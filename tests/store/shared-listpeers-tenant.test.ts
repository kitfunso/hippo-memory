/**
 * D4 v1.12.10 — listPeers tenant-scoping.
 *
 * Pre-D4: listPeers aggregated all entries in the global store regardless
 * of tenant_id. Post-D4: optional tenantId param filters to that tenant
 * before aggregation; ALL_TENANTS is the host-wide view.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { folderStore } from '../_helpers/sharing-stores.js';
import { listPeers } from '../../src/sharing/share.js';
import { Layer } from '../../src/core/memory.js';
import type { MemoryEntry } from '../../src/core/memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { ALL_TENANTS } from '../../src/util/tenant.js';

function makeSharedEntry(opts: { id: string; project: string; tenantId: string }): MemoryEntry {
  return {
    id: opts.id,
    content: `entry from ${opts.project} for tenant ${opts.tenantId}`,
    created: '2026-05-24T10:00:00.000Z',
    lastRetrieved: '2026-05-24T10:00:00.000Z',
    retrievalCount: 0,
    strength: 1.0,
    halfLifeDays: 30,
    layer: Layer.Semantic,
    tags: [],
    emotionalValence: 'neutral',
    schemaFit: 0.7,
    source: `shared:${opts.project}:`,
    outcomeScore: null,
    outcomePositive: 0,
    outcomeNegative: 0,
    conflictsWith: [],
    pinned: false,
    confidence: 'verified',
    parents: [],
    starred: false,
    traceOutcome: null,
    sourceSessionId: null,
    validFrom: '2026-05-24T10:00:00.000Z',
    supersededBy: null,
    extractedFrom: null,
    dagLevel: 0,
    dagParentId: null,
    kind: 'distilled',
    scope: null,
    owner: null,
    artifactRef: null,
    tenantId: opts.tenantId,
  };
}

describe('listPeers tenant scoping', () => {
  let globalRoot: string;

  beforeEach(() => {
    globalRoot = makeRoot('listpeers-tenant');
    // Seed entries from 3 projects across 2 tenants.
    writeEntry(globalRoot, makeSharedEntry({ id: 'mem_a1', project: 'projectA', tenantId: 'acme' }));
    writeEntry(globalRoot, makeSharedEntry({ id: 'mem_a2', project: 'projectA', tenantId: 'acme' }));
    writeEntry(globalRoot, makeSharedEntry({ id: 'mem_b1', project: 'projectB', tenantId: 'acme' }));
    writeEntry(globalRoot, makeSharedEntry({ id: 'mem_c1', project: 'projectC', tenantId: 'globex' }));
    writeEntry(globalRoot, makeSharedEntry({ id: 'mem_c2', project: 'projectC', tenantId: 'globex' }));
  });

  it('ALL_TENANTS: returns host-wide peers', async () => {
    const peers = await listPeers(folderStore(globalRoot), ALL_TENANTS);
    const map = new Map(peers.map((p) => [p.project, p.count]));
    expect(map.get('projectA')).toBe(2);
    expect(map.get('projectB')).toBe(1);
    expect(map.get('projectC')).toBe(2);
    expect(peers).toHaveLength(3);
  });

  it('tenantId=acme: filters to projects whose memories carry tenant_id=acme', async () => {
    const peers = await listPeers(folderStore(globalRoot), 'acme');
    const map = new Map(peers.map((p) => [p.project, p.count]));
    expect(map.get('projectA')).toBe(2);
    expect(map.get('projectB')).toBe(1);
    expect(map.get('projectC')).toBeUndefined(); // globex projects filtered out
    expect(peers).toHaveLength(2);
  });

  it('tenantId=globex: filters to projectC only', async () => {
    const peers = await listPeers(folderStore(globalRoot), 'globex');
    expect(peers).toHaveLength(1);
    expect(peers[0]!.project).toBe('projectC');
    expect(peers[0]!.count).toBe(2);
  });

  it('tenantId=unknown-tenant: returns empty array', async () => {
    const peers = await listPeers(folderStore(globalRoot), 'never-existed');
    expect(peers).toEqual([]);
  });
});
