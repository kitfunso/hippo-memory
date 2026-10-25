// ContextReads answers: the same values, the same errors, no audit row.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { auditRowsOn } from '../_helpers/audit-rows.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import type {
  AmbientCandidateRequest,
  AmbientLoadResult,
  AmbientStoreFilter,
  AmbientTallies,
  AuditEvent,
  ContinuityKey,
  MemoryEntry,
} from '../../src/entry/store-kit.js';
import { CONTEXT_NOW, OWN_SCOPE, OWNER, PROJECT, seedContextRows } from '../_helpers/context-fixture.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import {
  runOnFixture,
  seedTwoTenants,
  TENANT_A,
  TENANT_B,
  type GroupCall,
  type Outcome,
  type TwoTenantFixture,
} from '../_helpers/store-conformance.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

type Call = GroupCall<'contextReads', unknown>;
type Named = readonly [string, Call];

let fixture: TwoTenantFixture;
let fixtureAudit: readonly AuditEvent[];

/** Runs the calls, asserts they wrote no audit row, and returns hippo.db's outcomes by name. */
async function conformsOn<G extends 'contextReads' | 'sessions'>(
  group: G,
  named: readonly (readonly [string, GroupCall<G, unknown>])[],
  on = fixture,
): Promise<Map<string, Outcome<unknown>>> {
  const sqlite = await runOnFixture(
    on,
    group,
    named.map(([, call]) => call),
  );
  if (on === fixture) expect(sqlite.audit).toEqual(fixtureAudit);
  return new Map(named.map(([name], i) => [name, sqlite.outcomes[i]]));
}

const conforms = (named: readonly Named[], on = fixture): Promise<Map<string, Outcome<unknown>>> =>
  conformsOn('contextReads', named, on);

const NOW = new Date(CONTEXT_NOW);
const HOUR = 3_600_000;

beforeAll(() => {
  fixture = seedTwoTenants();
  seedContextRows(fixture.dir);
  const db = openHippoDb(fixture.dir);
  try {
    fixtureAudit = auditRowsOn(db);
  } finally {
    closeHippoDb(db);
  }
});

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
const idsIn = (outcome: Outcome<unknown> | undefined): string[] =>
  JSON.stringify(outcome ?? null).match(/mem_[a-z0-9_]+/g) ?? [];

/** Rows the default deny refuses: another person's personal scope and the legacy quarantine bucket. */
const DENIED: readonly string[] = ['mem_a_bob', 'mem_a_legacy'];

function recallIds(outcome: Outcome<unknown> | undefined): string[] {
  if (outcome === undefined || !('value' in outcome)) return [];
  // SAFETY: every ambient() call resolves to { result: AmbientLoadResult }.
  const { result } = outcome.value as { result: AmbientLoadResult };
  return (result.recall ?? []).map((e) => e.id);
}

describe("the context's unfinished handoff, through Sessions.read 'handoff'", () => {
  it('reads alike under every key and age', async () => {
    const unfinished = (maxAgeMs: number) =>
      ({ sessionId: null, unfinishedOnly: true, maxAgeMs, scopeFilter: 'default-deny' }) as const;
    const calls: (readonly [string, GroupCall<'sessions', unknown>])[] = [];
    for (const [k, key] of KEYS) {
      for (const hours of [72, 2, 1000]) {
        calls.push([`unfinished ${k} ${hours}h`, (g) => g.read(TENANT_A, 'handoff', unfinished(hours * HOUR), key)]);
      }
    }
    calls.push(['unfinished globex', (g) => g.read(TENANT_B, 'handoff', unfinished(72 * HOUR), null)]);
    const out = await conformsOn('sessions', calls);

    expect(out.get('unfinished no key 72h')).toMatchObject({ value: { summary: 'partial handoff for session b' } });
    expect(out.get('unfinished no key 2h')).toEqual({ value: null });
    expect(out.get('unfinished alice 72h')).toMatchObject({ value: { summary: 'alice handoff' } });
    expect(out.get('unfinished no owner 72h')).toEqual({ value: null });
    expect(out.get('unfinished globex')).toMatchObject({ value: { summary: 'globex handoff' } });
  });
});

/** An ambient load in PROJECT, which refuses other projects' rows unless `cross`; each answer lists its refusals in read order. */
function ambient(
  tenantId: string,
  recentNeeded: number,
  more: Omit<AmbientCandidateRequest, 'admit' | 'recentNeeded'> = {},
  cross = false,
): Call {
  return async (g) => ({
    result: await g.ambientCandidates(tenantId, {
      recentNeeded,
      admit: { currentProject: PROJECT, includeCrossProject: cross },
      ...more,
    }),
  });
}

describe('ContextReads.ambientCandidates', () => {
  it('reads pins, every recent window and prompt recall alike', async () => {
    const own = { names: [PROJECT], userGlobal: true };
    const out = await conforms([
      ['pins only', ambient(TENANT_A, 0)],
      ['first window suffices', ambient(TENANT_A, 5, {}, true)],
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

    expect(out.get('drifted')).toMatchObject({
      value: { result: { entries: expect.arrayContaining([expect.objectContaining({ id: 'mem_b_drift' })]) } },
    });
    expect(out.get('recall')).toMatchObject({
      value: { result: { recall: expect.arrayContaining([expect.objectContaining({ id: 'mem_a_error' })]) } },
    });
    expect(out.get('recall no term indexed')).toMatchObject({ value: { result: { recall: [] } } });
    expect(out.get('no names')).toMatchObject({ value: { result: { entries: [{ id: 'mem_a_pin' }] } } });
    // Pins are read oldest first: the other project's pin, then the private one the default deny refuses.
    expect(out.get('pins only')).toMatchObject({
      value: {
        result: {
          refused: [
            { id: 'mem_a_pin_other', reason: 'admission' },
            { id: 'mem_a_pin_private', reason: 'admission' },
          ],
        },
      },
    });
    // The first tenant's loads never show, or refuse, a second-tenant row.
    for (const [name, outcome] of out) {
      if (name !== 'drifted') {
        expect(
          idsIn(outcome).filter((id) => id.startsWith('mem_b_')),
          name,
        ).toEqual([]);
      }
    }
    // Prompt recall applies the default deny itself: another person's personal row and the legacy bucket stay out, the caller's own comes in.
    for (const name of ['recall', 'recall own scope']) {
      expect(
        recallIds(out.get(name)).filter((id) => DENIED.includes(id)),
        name,
      ).toEqual([]);
    }
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
      expect(
        idsIn(outcome).filter((id) => id.startsWith('mem_b_')),
        name,
      ).toEqual([]);
      if (name !== 'exact scope') {
        expect(
          idsIn(outcome).filter((id) => DENIED.includes(id)),
          name,
        ).toEqual([]);
      }
    }
    expect(idsIn(out.get('every row'))).toEqual(expect.arrayContaining(['mem_a_team']));
    expect(idsIn(out.get('own scope, every row'))).toEqual(expect.arrayContaining(['mem_a_alice']));
  });
});

/** Tag order follows the store's row order and the strength sum is floating point, so both go into one form first. */
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
    const tally =
      (tenantId: string, filter: Partial<AmbientStoreFilter> = {}): Call =>
      async (g) =>
        comparable(await g.ambientTallies(tenantId, { currentProject: [PROJECT], now: NOW, ...filter }));
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

/** Digest, vault and tagged rows over both tenants, apart from the contextGet fixture so its windows stay as they are. */
function seedRowReads(dir: string): void {
  const at = (minute: number): string => new Date(Date.UTC(2026, 2, 1, 0, minute)).toISOString();
  const row = (content: string, minute: number, over: Parameters<typeof createMemory>[1] = {}): MemoryEntry => ({
    ...createMemory(content, { tenantId: TENANT_A, ...over }),
    created: at(minute),
    id: `mem_r_${minute}`,
  });
  const digest = { source: 'session-digest', tags: ['session-digest'] };
  const rows = [
    row('digest of session one', 1, { ...digest, sourceSessionId: 's1' }),
    row('digest of session two', 2, { ...digest, sourceSessionId: 's2' }),
    row('digest with no session', 3, digest),
    row('digest extracted from a raw row', 4, { ...digest, extractedFrom: 'mem_r_9' }),
    { ...row('digest replaced since', 5, digest), supersededBy: 'mem_r_2' },
    row('digest tag only in content: session-digest', 6, { source: 'session-digest', tags: ['other'] }),
    row('digest of tenant b', 7, { ...digest, tenantId: TENANT_B }),
    row('vault note a', 8, { kind: 'raw', artifactRef: 'vault:notes:a.md', tags: ['vault', 'pipeline'] }),
    row('vault note other case', 9, { kind: 'raw', artifactRef: 'vault:Notes:b.md', tags: ['vault'] }),
    row('vault note under a wildcard name', 10, { kind: 'raw', artifactRef: 'vault:notesX:c.md', tags: ['vault'] }),
    row('vault note distilled', 11, { artifactRef: 'vault:notes:d.md', tags: ['vault'] }),
    row('vault note of tenant b', 12, { kind: 'raw', artifactRef: 'vault:notes:e.md', tenantId: TENANT_B }),
    { ...row('same minute, later id', 13, { tags: ['pipeline'] }), id: 'mem_r_13b' },
    row('same minute, earlier id', 13, { tags: ['pipeline', 'deploy'] }),
  ];
  for (const e of rows) writeEntry(dir, e);
}

describe('ContextReads row reads', () => {
  let rowsFixture: TwoTenantFixture;

  beforeAll(() => {
    rowsFixture = seedTwoTenants();
    seedRowReads(rowsFixture.dir);
  });

  afterAll(() => rmSync(rowsFixture.dir, { recursive: true, force: true }));

  it('read schema fit alike', async () => {
    const out = await conforms(
      [
        ['fit pipeline', (g) => g.schemaFit(TENANT_A, 'a pipeline note', ['pipeline'])],
        ['fit no tags', (g) => g.schemaFit(TENANT_A, 'vault note', [])],
        ['fit empty tenant', (g) => g.schemaFit('nobody', 'anything', ['pipeline'])],
      ],
      rowsFixture,
    );

    expect(out.get('fit pipeline')).toMatchObject({ value: expect.any(Number) });
  });
});
