/**
 * D4 v1.12.10 — listPeers tenant-scoping.
 *
 * Pre-D4: listPeers aggregated all entries in the global store regardless
 * of tenant_id. Post-D4: optional tenantId param filters to that tenant
 * before aggregation. Undefined keeps host-wide behaviour for back-compat.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { listPeers } from '../src/shared.js';
import { Layer } from '../src/memory.js';
import type { MemoryEntry } from '../src/memory.js';

function makeSharedEntry(opts: { id: string; project: string; tenantId: string }): MemoryEntry {
  return {
    id: opts.id,
    content: `entry from ${opts.project} for tenant ${opts.tenantId}`,
    created: '2026-05-24T10:00:00.000Z',
    last_retrieved: '2026-05-24T10:00:00.000Z',
    retrieval_count: 0,
    strength: 1.0,
    half_life_days: 30,
    layer: Layer.Semantic,
    tags: [],
    emotional_valence: 'neutral',
    schema_fit: 0.7,
    source: `shared:${opts.project}:`,
    outcome_score: null,
    outcome_positive: 0,
    outcome_negative: 0,
    conflicts_with: [],
    pinned: false,
    confidence: 'verified',
    parents: [],
    starred: false,
    trace_outcome: null,
    source_session_id: null,
    valid_from: '2026-05-24T10:00:00.000Z',
    superseded_by: null,
    extracted_from: null,
    dag_level: 0,
    dag_parent_id: null,
    kind: 'distilled',
    scope: null,
    owner: null,
    artifact_ref: null,
    tenantId: opts.tenantId,
  };
}

describe('listPeers tenant scoping (D4 v1.12.10)', () => {
  let globalRoot: string;

  beforeEach(() => {
    globalRoot = mkdtempSync(join(tmpdir(), 'hippo-listpeers-tenant-'));
    initStore(globalRoot);
    // Seed entries from 3 projects across 2 tenants.
    writeEntry(globalRoot, makeSharedEntry({ id: 'mem_a1', project: 'projectA', tenantId: 'acme' }));
    writeEntry(globalRoot, makeSharedEntry({ id: 'mem_a2', project: 'projectA', tenantId: 'acme' }));
    writeEntry(globalRoot, makeSharedEntry({ id: 'mem_b1', project: 'projectB', tenantId: 'acme' }));
    writeEntry(globalRoot, makeSharedEntry({ id: 'mem_c1', project: 'projectC', tenantId: 'globex' }));
    writeEntry(globalRoot, makeSharedEntry({ id: 'mem_c2', project: 'projectC', tenantId: 'globex' }));
  });

  afterEach(() => {
    rmSync(globalRoot, { recursive: true, force: true });
  });

  it('no tenantId arg: returns host-wide peers (back-compat)', () => {
    const peers = listPeers(globalRoot);
    const map = new Map(peers.map((p) => [p.project, p.count]));
    expect(map.get('projectA')).toBe(2);
    expect(map.get('projectB')).toBe(1);
    expect(map.get('projectC')).toBe(2);
    expect(peers).toHaveLength(3);
  });

  it('tenantId=acme: filters to projects whose memories carry tenant_id=acme', () => {
    const peers = listPeers(globalRoot, 'acme');
    const map = new Map(peers.map((p) => [p.project, p.count]));
    expect(map.get('projectA')).toBe(2);
    expect(map.get('projectB')).toBe(1);
    expect(map.get('projectC')).toBeUndefined(); // globex projects filtered out
    expect(peers).toHaveLength(2);
  });

  it('tenantId=globex: filters to projectC only', () => {
    const peers = listPeers(globalRoot, 'globex');
    expect(peers).toHaveLength(1);
    expect(peers[0]!.project).toBe('projectC');
    expect(peers[0]!.count).toBe(2);
  });

  it('tenantId=unknown-tenant: returns empty array', () => {
    const peers = listPeers(globalRoot, 'never-existed');
    expect(peers).toEqual([]);
  });

  it('tenantId=undefined explicit: equivalent to omitting the arg', () => {
    const a = listPeers(globalRoot);
    const b = listPeers(globalRoot, undefined);
    expect(b).toEqual(a);
  });
});
