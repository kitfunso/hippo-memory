import { describe, it, expect, beforeEach } from 'vitest';
import { extractGraph } from '../../src/domain/graph/extract.js';
import { makeRoot } from '../_helpers/make-root.js';
import { objectsAt } from '../_helpers/objects-at.js';
import { withSharedStoreHandles } from '../../src/db/index.js';
import { loadConfig } from '../../src/host/config-file.js';
import { deleteEntry, loadEntities, loadRelations } from '../_helpers/root-forms.js';
import { saveCustomerNote, saveDecision, savePolicy, saveProjectBrief } from '../../src/entry/testing.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

const { sqliteStore } = sessionPerTest();

const T = 'default';
function refs(home: string, tenant: string = T) {
  return loadRelations(home, tenant, { limit: 1000 }).filter((r) => r.relType === 'references');
}
function entByName(home: string, name: string) {
  return loadEntities(home, T, { limit: 1000 }).find((e) => e.name === name);
}

describe('cross-object references (Pass 3 name-match)', () => {
  let home: string;
  beforeEach(() => {
    home = makeRoot('graph-xobj');
  });

  it('a decision whose text names a policy emits one references edge (decision -> policy), sourced from the decision memory', async () => {
    const pol = await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      policyName: 'RetryPolicy',
      policyText: 'retry up to 3x',
    });
    const dec = await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      decisionText: 'We adopt RetryPolicy for all services',
    });
    const r = await extractGraph(sqliteStore(home), T);
    expect(r.references).toBe(1);
    const edges = refs(home);
    expect(edges).toHaveLength(1);
    const decEnt = entByName(home, 'We adopt RetryPolicy for all services')!;
    const polEnt = entByName(home, 'RetryPolicy')!;
    expect(edges[0].fromEntityId).toBe(decEnt.id);
    expect(edges[0].toEntityId).toBe(polEnt.id);
    expect(edges[0].memoryId).toBe(dec.memoryId);
    expect(edges[0].sourceKind === 'distilled' || edges[0].sourceKind === 'superseded').toBe(true);
    void pol;
  });

  it('no self-edge (an object whose own name appears in its own text)', async () => {
    await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      policyName: 'SelfRef',
      policyText: 'SelfRef governs SelfRef itself',
    });
    await extractGraph(sqliteStore(home), T);
    expect(refs(home)).toHaveLength(0);
  });

  it('word-boundary: a policy named Cache does not match the substring in "cached"', async () => {
    await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      policyName: 'Cache',
      policyText: 'caching config',
    });
    await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      decisionText: 'the system cached results last week',
    });
    await extractGraph(sqliteStore(home), T);
    expect(refs(home)).toHaveLength(0);
  });

  it('MIN_NAME_LEN: a sub-4-char name is not a target', async () => {
    await saveCustomerNote(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      customer: 'Abc',
      note: 'short name customer',
    });
    await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      decisionText: 'we onboarded Abc this quarter',
    });
    await extractGraph(sqliteStore(home), T);
    expect(refs(home)).toHaveLength(0);
  });

  it('MAX_NAME_LEN: a long prose decision is a source but never a target', async () => {
    const longText = 'Adopt the new microservices event-driven architecture with sagas and CQRS for the order domain';
    expect(longText.length).toBeGreaterThan(80);
    await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, { decisionText: longText });
    await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      decisionText: `${longText} - refined further`,
    });
    await extractGraph(sqliteStore(home), T);
    expect(refs(home)).toHaveLength(0);
  });

  it('ambiguity guard: a name shared by two entities (policy + customer) emits no edge', async () => {
    await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      policyName: 'Shared',
      policyText: 'a policy',
    });
    await saveCustomerNote(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      customer: 'Shared',
      note: 'a customer',
    });
    await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      decisionText: 'this references Shared somehow',
    });
    await extractGraph(sqliteStore(home), T);
    expect(refs(home)).toHaveLength(0);
  });

  it('per-source cap: a decision naming many policies is capped at 25', async () => {
    const names = Array.from({ length: 30 }, (_, i) => `PolicyNum${String(i).padStart(3, '0')}`);
    await withSharedStoreHandles(async (session) => {
      const objects = objectsAt(home, session);
      for (const n of names) {
        await savePolicy(objects, loadConfig(home).defaultHalfLifeDays, T, { policyName: n, policyText: 'x' });
      }
    });

    await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      decisionText: `a decision that mentions ${names.join(' and ')}`,
    });
    await extractGraph(sqliteStore(home), T);
    expect(refs(home).length).toBe(25);
  });

  it('idempotent: re-running extractGraph yields the same references (no duplication)', async () => {
    await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      policyName: 'CacheTtl',
      policyText: 'ttl 60s',
    });
    await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      decisionText: 'tune CacheTtl down',
    });
    const r1 = await extractGraph(sqliteStore(home), T);
    const r2 = await extractGraph(sqliteStore(home), T);
    expect(r1.references).toBe(1);
    expect(r2.references).toBe(1);
    expect(refs(home)).toHaveLength(1);
  });

  it('a forgotten (null memory_id) source STILL emits its edge, anchored to the E2 object (v38 provenance)', async () => {
    await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      policyName: 'AlphaPolicy',
      policyText: 'p',
    });
    const dec = await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      decisionText: 'uses AlphaPolicy heavily',
    });
    deleteEntry(home, dec.memoryId!);
    await extractGraph(sqliteStore(home), T);
    const edges = refs(home);
    expect(edges).toHaveLength(1);
    const decEnt = entByName(home, 'uses AlphaPolicy heavily')!;
    const polEnt = entByName(home, 'AlphaPolicy')!;
    expect(edges[0].fromEntityId).toBe(decEnt.id);
    expect(edges[0].toEntityId).toBe(polEnt.id);
  });

  it('a supersedes pair is not ALSO given a references edge (name-containment artifact)', async () => {
    const d1 = await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      decisionText: 'Adopt Postgres',
    });
    await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      decisionText: 'Adopt Postgres (managed)',
      supersedesDecisionId: d1.id,
    });
    const r = await extractGraph(sqliteStore(home), T);
    expect(r.references).toBe(0);
    expect(r.relations).toBe(1);
    expect(refs(home)).toHaveLength(0);
  });

  it('a project_brief source (repo/summary text) referencing a policy emits an edge (project -> policy)', async () => {
    await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      policyName: 'GreenPolicy',
      policyText: 'carbon-aware scheduling',
    });
    await saveProjectBrief(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      repo: 'myrepo',
      summary: 'this service enforces GreenPolicy across jobs',
    });
    const r = await extractGraph(sqliteStore(home), T);
    expect(r.references).toBe(1);
    const projEnt = entByName(home, 'myrepo')!;
    const polEnt = entByName(home, 'GreenPolicy')!;
    const edges = refs(home);
    expect(edges).toHaveLength(1);
    expect(edges[0].fromEntityId).toBe(projEnt.id);
    expect(edges[0].toEntityId).toBe(polEnt.id);
  });

  it('superseded TARGET is excluded: a name belonging to a superseded policy is not referenced (codex)', async () => {
    const p1 = await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      policyName: 'OldPol',
      policyText: 'v1',
    });
    await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      policyName: 'NewPol',
      policyText: 'v2',
      supersedesPolicyId: p1.id,
    });
    await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      decisionText: 'we still cite OldPol but adopt NewPol',
    });
    await extractGraph(sqliteStore(home), T);
    const edges = refs(home);
    expect(edges).toHaveLength(1);
    expect(entByName(home, 'NewPol')!.id).toBe(edges[0].toEntityId);
  });

  it('superseded SOURCE is excluded: a superseded decision emits no references (codex)', async () => {
    await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      policyName: 'LivePolicy',
      policyText: 'p',
    });
    const d1 = await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      decisionText: 'd1 leans on LivePolicy',
    });
    await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      decisionText: 'd2 supersedes the prior call',
      supersedesDecisionId: d1.id,
    });
    await extractGraph(sqliteStore(home), T);
    expect(refs(home)).toHaveLength(0);
  });

  it('longest-match: a prefix name does not shadow a longer entity name (codex)', async () => {
    await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      policyName: 'postgres',
      policyText: 'a',
    });
    await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      policyName: 'postgres pro',
      policyText: 'b',
    });
    await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      decisionText: 'migrate to postgres pro this quarter',
    });
    await extractGraph(sqliteStore(home), T);
    const edges = refs(home);
    expect(edges).toHaveLength(1);
    expect(entByName(home, 'postgres pro')!.id).toBe(edges[0].toEntityId);
  });

  it('a source naming two distinct targets emits two references edges', async () => {
    await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      policyName: 'PolicyAlpha',
      policyText: 'a',
    });
    await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      policyName: 'PolicyBeta',
      policyText: 'b',
    });
    await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      decisionText: 'balance PolicyAlpha against PolicyBeta carefully',
    });
    const r = await extractGraph(sqliteStore(home), T);
    expect(r.references).toBe(2);
    const tgts = new Set(refs(home).map((e) => e.toEntityId));
    expect(tgts.has(entByName(home, 'PolicyAlpha')!.id)).toBe(true);
    expect(tgts.has(entByName(home, 'PolicyBeta')!.id)).toBe(true);
  });

  it('tenant isolation: a name in another tenant object is never matched', async () => {
    await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'tenantA', {
      policyName: 'TenantAPolicy',
      policyText: 'p',
    });
    await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'tenantB', {
      decisionText: 'mentions TenantAPolicy from another tenant',
    });
    await extractGraph(sqliteStore(home), 'tenantA');
    await extractGraph(sqliteStore(home), 'tenantB');
    expect(refs(home, 'tenantB')).toHaveLength(0);
    expect(refs(home, 'tenantA')).toHaveLength(0);
  });
});
