// ContextReads answers alike on hippo.db and on a store held in memory: the same values, the same errors, no audit row.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { listAuditEventsAfter } from '../src/store/audit.js';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import type {
  AmbientCandidateRequest, AmbientLoadResult, AmbientStoreFilter, AmbientTallies, AuditEvent, ContinuityKey, MemoryEntry,
} from '../src/server.js';
import { CONTEXT_NOW, OWN_SCOPE, OWNER, PROJECT, seedContextRows } from './_helpers/context-fixture.js';
import { inMemoryContextStore } from './_helpers/in-memory-context-store.js';
import { onBothStores, seedTwoTenants, TENANT_A, TENANT_B, type GroupCall, type Outcome, type TwoTenantFixture } from './_helpers/store-conformance.js';

type Call = GroupCall<'contextReads', unknown>;
type Named = readonly [string, Call];

let fixture: TwoTenantFixture;
let fixtureAudit: readonly AuditEvent[];

/** Runs the calls on both stores, asserts they agree and wrote no audit row, and returns hippo.db's outcomes by name. */
async function conforms(named: readonly Named[]): Promise<Map<string, Outcome<unknown>>> {
  const sides = await onBothStores(fixture, 'contextReads', inMemoryContextStore, named.map(([, call]) => call));
  expect(sides.other).toEqual(sides.sqlite);
  expect(sides.sqlite.audit).toEqual(fixtureAudit);
  return new Map(named.map(([name], i) => [name, sides.sqlite.outcomes[i]]));
}

const NOW = new Date(CONTEXT_NOW);
const HOUR = 3_600_000;

beforeAll(() => {
  fixture = seedTwoTenants();
  seedContextRows(fixture.dir);
  const db = openHippoDb(fixture.dir);
  try {
    fixtureAudit = listAuditEventsAfter(db, { afterId: 0, limit: 10_000 });
  } finally {
    closeHippoDb(db);
  }
}, 60_000);

afterAll(() => {
  rmSync(fixture.dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const KEYS: readonly (readonly [string, ContinuityKey | null])[] = [
  ['no key', null],
  ['alice', { owner: OWNER, project: [PROJECT] }],
  ['bob with a blank name', { owner: 'bob', project: [PROJECT, ''] }],
  ['no owner', { owner: '', project: [PROJECT] }],
  ['alice with only a blank name', { owner: OWNER, project: [''] }],
];

/** Every memory id an outcome holds anywhere, so a test can say which rows a read never let through. */
const idsIn = (outcome: Outcome<unknown> | undefined): string[] => JSON.stringify(outcome ?? null).match(/mem_[a-z0-9_]+/g) ?? [];

/** Rows the default deny refuses: another person's personal scope and the legacy quarantine bucket. */
const DENIED: readonly string[] = ['mem_a_bob', 'mem_a_legacy'];

function recallIds(outcome: Outcome<unknown> | undefined): string[] {
  if (outcome === undefined || !('value' in outcome)) return [];
  // SAFETY: every ambient() call resolves to { result: AmbientLoadResult, seen }.
  const { result } = outcome.value as { result: AmbientLoadResult };
  return (result.recall ?? []).map((e) => e.id);
}

describe('ContextReads.unfinishedHandoff', () => {
  it('reads alike under every key, age and bad tenant', async () => {
    const calls: Named[] = [];
    for (const [k, key] of KEYS) {
      for (const hours of [72, 2, 1000]) calls.push([`unfinished ${k} ${hours}h`, (g) => g.unfinishedHandoff(TENANT_A, hours * HOUR, key)]);
    }
    calls.push(['unfinished globex', (g) => g.unfinishedHandoff(TENANT_B, 72 * HOUR, null)]);
    for (const bad of ['', 'sess-x']) calls.push([`unfinished bad ${bad}`, (g) => g.unfinishedHandoff(bad, HOUR, null)]);
    const out = await conforms(calls);

    expect(out.get('unfinished no key 72h')).toMatchObject({ value: { summary: 'partial handoff for session b' } });
    expect(out.get('unfinished no key 2h')).toEqual({ value: null });
    expect(out.get('unfinished alice 72h')).toMatchObject({ value: { summary: 'alice handoff' } });
    expect(out.get('unfinished no owner 72h')).toEqual({ value: null });
    expect(out.get('unfinished globex')).toMatchObject({ value: { summary: 'globex handoff' } });
    expect(out.get('unfinished bad ')).toEqual({ error: expect.stringContaining('tenantId is required') });
    expect(out.get('unfinished bad sess-x')).toEqual({ error: expect.stringContaining('looks like a session id') });
  });
});

/** An ambient load whose admit refuses one origin and records every id it saw, in order. */
function ambient(tenantId: string, recentNeeded: number, more: Omit<AmbientCandidateRequest, 'admit' | 'recentNeeded'> = {}, refuse: string | null = 'other'): Call {
  return async (g) => {
    const seen: string[] = [];
    const admit = (e: MemoryEntry): boolean => {
      seen.push(e.id);
      return e.origin_project !== refuse;
    };
    return { result: await g.ambientCandidates(tenantId, { recentNeeded, admit, ...more }), seen };
  };
}

describe('ContextReads.ambientCandidates', () => {
  it('reads pins, every recent window and prompt recall alike', async () => {
    const own = { names: [PROJECT], userGlobal: true };
    const out = await conforms([
      ['pins only', ambient(TENANT_A, 0)],
      ['first window suffices', ambient(TENANT_A, 5, {}, null)],
      ['own window', ambient(TENANT_A, 10, { origins: own })],
      ['full scan', ambient(TENANT_A, 10)],
      ['fractional', ambient(TENANT_A, 3.7)],
      ['own names only', ambient(TENANT_A, 3, { origins: { names: [PROJECT], userGlobal: false } })],
      ['no names', ambient(TENANT_A, 2, { origins: { names: [], userGlobal: false } })],
      ['drifted', ambient(TENANT_B, 2)],
      ['recall', ambient(TENANT_A, 0, { recall: { terms: ['rollout', 'billing', 'zebra', 'deploy'], limit: 5 } })],
      ['recall no term indexed', ambient(TENANT_A, 0, { recall: { terms: ['nothingmatches', 'Rollout'], limit: 5 } })],
      ['recall own scope', ambient(TENANT_A, 0, { recall: { terms: ['rollout'], limit: 20, ownScope: OWN_SCOPE } })],
      ['recall split term', ambient(TENANT_A, 2, { recall: { terms: ['zebra_cache', 'queue'], limit: 3 } })],
      ['no tenant', ambient('', 3)],
    ]);

    expect(out.get('drifted')).toMatchObject({ value: { result: { entries: expect.arrayContaining([expect.objectContaining({ id: 'mem_b_drift' })]) } } });
    expect(out.get('recall')).toMatchObject({ value: { result: { recall: expect.arrayContaining([expect.objectContaining({ id: 'mem_a_error' })]) } } });
    expect(out.get('recall no term indexed')).toMatchObject({ value: { result: { recall: [] } } });
    expect(out.get('no names')).toMatchObject({ value: { result: { entries: [{ id: 'mem_a_pin' }, { id: 'mem_a_pin_private' }] } } });
    // The first tenant's loads never show, or ask admit about, a second-tenant row.
    for (const [name, outcome] of out) if (name !== 'drifted') expect(idsIn(outcome).filter((id) => id.startsWith('mem_b_')), name).toEqual([]);
    // Prompt recall applies the default deny itself: another person's personal row and the legacy bucket stay out, the caller's own comes in.
    for (const name of ['recall', 'recall own scope']) expect(recallIds(out.get(name)).filter((id) => DENIED.includes(id)), name).toEqual([]);
    expect(recallIds(out.get('recall own scope'))).toEqual(expect.arrayContaining(['mem_a_alice']));
  });
});

describe('ContextReads.contextCandidates', () => {
  it('ranks, caps and filters alike', async () => {
    const later = new Date(NOW.getTime() + 400 * HOUR);
    const out = await conforms([
      ['every row', (g) => g.contextCandidates(TENANT_A, { cap: 2000, now: NOW })],
      ['cap 3', (g) => g.contextCandidates(TENANT_A, { cap: 3, now: NOW })],
      ['cap 0', (g) => g.contextCandidates(TENANT_A, { cap: 0, now: NOW })],
      ['cap 2.9', (g) => g.contextCandidates(TENANT_A, { cap: 2.9, now: NOW })],
      ['exact scope', (g) => g.contextCandidates(TENANT_A, { exactScope: 'team:eng', cap: 2000, now: NOW })],
      ['own scope', (g) => g.contextCandidates(TENANT_A, { ownScope: OWN_SCOPE, cap: 12, now: NOW })],
      ['own scope, every row', (g) => g.contextCandidates(TENANT_A, { ownScope: OWN_SCOPE, cap: 2000, now: NOW })],
      ['project', (g) => g.contextCandidates(TENANT_A, { project: [PROJECT], cap: 10, now: NOW })],
      ['empty project', (g) => g.contextCandidates(TENANT_A, { project: [], cap: 10, now: NOW })],
      ['globex', (g) => g.contextCandidates(TENANT_B, { cap: 2000, now: NOW })],
      ['later', (g) => g.contextCandidates(TENANT_A, { cap: 8, now: later })],
    ]);

    expect(out.get('cap 0')).toEqual({ value: [] });
    expect(out.get('cap 2.9')).toMatchObject({ value: { length: 2 } });
    expect(out.get('exact scope')).toMatchObject({ value: [{ id: 'mem_a_team' }] });
    for (const [name, outcome] of out) {
      if (name === 'globex') continue;
      expect(idsIn(outcome).filter((id) => id.startsWith('mem_b_')), name).toEqual([]);
      if (name !== 'exact scope') expect(idsIn(outcome).filter((id) => DENIED.includes(id)), name).toEqual([]);
    }
    expect(idsIn(out.get('every row'))).toEqual(expect.arrayContaining(['mem_a_team']));
    expect(idsIn(out.get('own scope, every row'))).toEqual(expect.arrayContaining(['mem_a_alice']));
  });
});

/** Tag order follows each store's row order and the strength sum is floating point, so both are put in one form first. */
const comparable = (t: AmbientTallies) => ({
  ...t,
  strengthSum: Number(t.strengthSum.toFixed(6)),
  tagCounts: [...t.tagCounts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
});

function tagsOf(outcome: Outcome<unknown> | undefined): string[] {
  if (outcome === undefined || !('value' in outcome)) return [];
  // SAFETY: every tally call resolves to comparable(), whose tagCounts are [tag, count] pairs.
  return (outcome.value as ReturnType<typeof comparable>).tagCounts.map(([tag]) => tag.toLowerCase());
}

describe('ContextReads.ambientTallies', () => {
  it('counts the same rows alike', async () => {
    const tally = (tenantId: string, filter: Partial<AmbientStoreFilter> = {}): Call => async (g) => comparable(await g.ambientTallies(tenantId, { currentProject: [PROJECT], now: NOW, ...filter }));
    const out = await conforms([
      ['every row', tally(TENANT_A)],
      ['project', tally(TENANT_A, { project: [PROJECT] })],
      ['no current project', tally(TENANT_A, { currentProject: [] })],
      ['other current project', tally(TENANT_A, { currentProject: ['other'] })],
      ['exact scope', tally(TENANT_A, { exactScope: 'team:eng' })],
      ['own scope', tally(TENANT_A, { ownScope: OWN_SCOPE })],
      ['globex', tally(TENANT_B)],
      ['no tenant', tally('')],
    ]);

    expect(out.get('exact scope')).toMatchObject({ value: { total: 1 } });
    expect(out.get('no tenant')).toMatchObject({ value: { total: 0 } });
    // Another project's secret-tagged row (mem_a_secret_other, tag Token) is left out unless that project is current.
    expect(tagsOf(out.get('every row'))).not.toContain('token');
    expect(tagsOf(out.get('every row'))).toContain('secret');
    expect(tagsOf(out.get('other current project'))).toContain('token');
  });
});
