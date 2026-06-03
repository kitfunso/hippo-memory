/**
 * E3.1 cross-object `references` edges (name-match, Pass 3) - tests.
 * Docs: docs/plans/2026-06-02-e3-cross-object-references.md
 *
 * extractGraph Pass 3 emits a `references` edge when one consolidated object's text
 * contains another extracted entity's name (conservative: word-boundary, length-bounded,
 * ambiguity-guarded, self-skipped, per-source capped, supersedes-pair-skipped). Real DB.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, deleteEntry } from '../src/store.js';
import { saveDecision } from '../src/decisions.js';
import { savePolicy } from '../src/policies.js';
import { saveCustomerNote } from '../src/customer-notes.js';
import { saveProjectBrief } from '../src/project-briefs.js';
import { loadEntities, loadRelations } from '../src/graph.js';
import { extractGraph, MAX_REFERENCES_PER_OBJECT } from '../src/graph-extract.js';

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-graph-xobj-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}
const T = 'default';
/** All `references` edges in a tenant's graph. */
function refs(home: string, tenant: string = T) {
  return loadRelations(home, tenant, { limit: 1000 }).filter((r) => r.relType === 'references');
}
function entByName(home: string, name: string) {
  return loadEntities(home, T, { limit: 1000 }).find((e) => e.name === name);
}

describe('E3.1 cross-object references (Pass 3 name-match)', () => {
  let home: string;
  beforeEach(() => { home = makeRoot(); });
  afterEach(() => { try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('a decision whose text names a policy emits one references edge (decision -> policy), sourced from the decision memory', () => {
    const pol = savePolicy(home, T, { policyName: 'RetryPolicy', policyText: 'retry up to 3x' });
    const dec = saveDecision(home, T, { decisionText: 'We adopt RetryPolicy for all services' });
    const r = extractGraph(home, T);
    expect(r.references).toBe(1);
    const edges = refs(home);
    expect(edges).toHaveLength(1);
    const decEnt = entByName(home, 'We adopt RetryPolicy for all services')!;
    const polEnt = entByName(home, 'RetryPolicy')!;
    expect(edges[0].fromEntityId).toBe(decEnt.id);
    expect(edges[0].toEntityId).toBe(polEnt.id);
    expect(edges[0].memoryId).toBe(dec.memoryId);           // source object's memory
    expect(edges[0].sourceKind === 'distilled' || edges[0].sourceKind === 'superseded').toBe(true);
    void pol;
  });

  it('no self-edge (an object whose own name appears in its own text)', () => {
    savePolicy(home, T, { policyName: 'SelfRef', policyText: 'SelfRef governs SelfRef itself' });
    extractGraph(home, T);
    expect(refs(home)).toHaveLength(0);
  });

  it('word-boundary: a policy named Cache does not match the substring in "cached"', () => {
    savePolicy(home, T, { policyName: 'Cache', policyText: 'caching config' });
    saveDecision(home, T, { decisionText: 'the system cached results last week' });
    extractGraph(home, T);
    expect(refs(home)).toHaveLength(0);
  });

  it('MIN_NAME_LEN: a sub-4-char name is not a target', () => {
    saveCustomerNote(home, T, { customer: 'Abc', note: 'short name customer' });
    saveDecision(home, T, { decisionText: 'we onboarded Abc this quarter' });
    extractGraph(home, T);
    expect(refs(home)).toHaveLength(0); // 'Abc' (3 chars) is below MIN_REF_NAME_LEN
  });

  it('MAX_NAME_LEN: a long prose decision is a source but never a target', () => {
    const longText = 'Adopt the new microservices event-driven architecture with sagas and CQRS for the order domain';
    expect(longText.length).toBeGreaterThan(80);
    saveDecision(home, T, { decisionText: longText });
    saveDecision(home, T, { decisionText: `${longText} - refined further` });
    extractGraph(home, T);
    // The second decision's text contains the first's full text verbatim, but the first's
    // name is > MAX_REF_NAME_LEN, so it is not a target -> no references edge.
    expect(refs(home)).toHaveLength(0);
  });

  it('ambiguity guard: a name shared by two entities (policy + customer) emits no edge', () => {
    savePolicy(home, T, { policyName: 'Shared', policyText: 'a policy' });
    saveCustomerNote(home, T, { customer: 'Shared', note: 'a customer' });
    saveDecision(home, T, { decisionText: 'this references Shared somehow' });
    extractGraph(home, T);
    expect(refs(home)).toHaveLength(0); // 'shared' maps to 2 entities -> dropped from index
  });

  it('per-source cap: a decision naming many policies is capped at MAX_REFERENCES_PER_OBJECT', () => {
    const names: string[] = [];
    for (let i = 0; i < MAX_REFERENCES_PER_OBJECT + 5; i++) {
      const n = `PolicyNum${String(i).padStart(3, '0')}`;
      names.push(n);
      savePolicy(home, T, { policyName: n, policyText: 'x' });
    }
    saveDecision(home, T, { decisionText: `a decision that mentions ${names.join(' and ')}` });
    extractGraph(home, T);
    expect(refs(home).length).toBe(MAX_REFERENCES_PER_OBJECT);
  });

  it('idempotent: re-running extractGraph yields the same references (no duplication)', () => {
    savePolicy(home, T, { policyName: 'CacheTtl', policyText: 'ttl 60s' });
    saveDecision(home, T, { decisionText: 'tune CacheTtl down' });
    const r1 = extractGraph(home, T);
    const r2 = extractGraph(home, T);
    expect(r1.references).toBe(1);
    expect(r2.references).toBe(1);
    expect(refs(home)).toHaveLength(1);
  });

  it('a forgotten (null memory_id) source STILL emits its edge, anchored to the E2 object (v38 provenance)', () => {
    savePolicy(home, T, { policyName: 'AlphaPolicy', policyText: 'p' });
    const dec = saveDecision(home, T, { decisionText: 'uses AlphaPolicy heavily' });
    // Delete the decision's mirror memory -> ON DELETE SET NULL nulls memory_id, but the
    // decision row stays active and authoritative. v38 anchors the entity to the E2 object,
    // so the forgotten-mirror decision is STILL a Pass-3 source (provenance = the object,
    // not the decaying mirror). This is the whole point of the graph/E2 provenance fix.
    deleteEntry(home, dec.memoryId!, T);
    expect(() => extractGraph(home, T)).not.toThrow();
    const edges = refs(home);
    expect(edges).toHaveLength(1); // forgotten-mirror decision still references AlphaPolicy
    const decEnt = entByName(home, 'uses AlphaPolicy heavily')!;
    const polEnt = entByName(home, 'AlphaPolicy')!;
    expect(edges[0].fromEntityId).toBe(decEnt.id);
    expect(edges[0].toEntityId).toBe(polEnt.id);
  });

  it('a supersedes pair is not ALSO given a references edge (name-containment artifact)', () => {
    const d1 = saveDecision(home, T, { decisionText: 'Adopt Postgres' });
    saveDecision(home, T, { decisionText: 'Adopt Postgres (managed)', supersedesDecisionId: d1.id });
    const r = extractGraph(home, T);
    expect(r.references).toBe(0);              // d2's name contains d1's, but they supersede
    expect(r.relations).toBe(1);               // only the supersedes edge
    expect(refs(home)).toHaveLength(0);
  });

  it('a project_brief source (repo/summary text) referencing a policy emits an edge (project -> policy)', () => {
    savePolicy(home, T, { policyName: 'GreenPolicy', policyText: 'carbon-aware scheduling' });
    saveProjectBrief(home, T, { repo: 'myrepo', summary: 'this service enforces GreenPolicy across jobs' });
    const r = extractGraph(home, T);
    expect(r.references).toBe(1);
    const projEnt = entByName(home, 'myrepo')!;
    const polEnt = entByName(home, 'GreenPolicy')!;
    const edges = refs(home);
    expect(edges).toHaveLength(1);
    expect(edges[0].fromEntityId).toBe(projEnt.id);
    expect(edges[0].toEntityId).toBe(polEnt.id);
  });

  it('superseded TARGET is excluded: a name belonging to a superseded policy is not referenced (codex)', () => {
    const p1 = savePolicy(home, T, { policyName: 'OldPol', policyText: 'v1' });
    savePolicy(home, T, { policyName: 'NewPol', policyText: 'v2', supersedesPolicyId: p1.id });
    saveDecision(home, T, { decisionText: 'we still cite OldPol but adopt NewPol' });
    extractGraph(home, T);
    const edges = refs(home);
    expect(edges).toHaveLength(1); // only the active NewPol, not the superseded OldPol
    expect(entByName(home, 'NewPol')!.id).toBe(edges[0].toEntityId);
  });

  it('superseded SOURCE is excluded: a superseded decision emits no references (codex)', () => {
    savePolicy(home, T, { policyName: 'LivePolicy', policyText: 'p' });
    const d1 = saveDecision(home, T, { decisionText: 'd1 leans on LivePolicy' });
    saveDecision(home, T, { decisionText: 'd2 supersedes the prior call', supersedesDecisionId: d1.id });
    extractGraph(home, T);
    expect(refs(home)).toHaveLength(0); // d1 (superseded source) skipped; d2 names nothing
  });

  it('longest-match: a prefix name does not shadow a longer entity name (codex)', () => {
    savePolicy(home, T, { policyName: 'postgres', policyText: 'a' });
    savePolicy(home, T, { policyName: 'postgres pro', policyText: 'b' });
    saveDecision(home, T, { decisionText: 'migrate to postgres pro this quarter' });
    extractGraph(home, T);
    const edges = refs(home);
    expect(edges).toHaveLength(1);
    expect(entByName(home, 'postgres pro')!.id).toBe(edges[0].toEntityId); // longest, not 'postgres'
  });

  it('a source naming two distinct targets emits two references edges', () => {
    savePolicy(home, T, { policyName: 'PolicyAlpha', policyText: 'a' });
    savePolicy(home, T, { policyName: 'PolicyBeta', policyText: 'b' });
    saveDecision(home, T, { decisionText: 'balance PolicyAlpha against PolicyBeta carefully' });
    const r = extractGraph(home, T);
    expect(r.references).toBe(2);
    const tgts = new Set(refs(home).map((e) => e.toEntityId));
    expect(tgts.has(entByName(home, 'PolicyAlpha')!.id)).toBe(true);
    expect(tgts.has(entByName(home, 'PolicyBeta')!.id)).toBe(true);
  });

  it('tenant isolation: a name in another tenant object is never matched', () => {
    savePolicy(home, 'tenantA', { policyName: 'TenantAPolicy', policyText: 'p' });
    saveDecision(home, 'tenantB', { decisionText: 'mentions TenantAPolicy from another tenant' });
    extractGraph(home, 'tenantA');
    extractGraph(home, 'tenantB');
    expect(refs(home, 'tenantB')).toHaveLength(0); // cross-tenant name never matched (per-tenant index)
    expect(refs(home, 'tenantA')).toHaveLength(0);
  });
});
