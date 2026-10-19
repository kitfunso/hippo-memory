// Policy, skill and brief-receipt lookups answer alike on hippo.db and on a store held in memory.
import { describe, expect, it, vi } from 'vitest';
import type { MemoryEntry } from '../../src/core/memory.js';
import { objectMirror } from '../../src/objects/lifecycle.js';
import type { BriefReceipt, ObjectFields, SavableKind } from '../../src/core/object-types.js';
import type { ObjectSave } from '../../src/store/port.js';
import { TENANT_A, TENANT_B } from '../_helpers/store-conformance.js';
import { loadConfig } from '../../src/core/config.js';
import {
  T1,
  T2,
  T3,
  ACTOR,
  type Call,
  fixture,
  conforms,
  close,
  added,
  useObjectsConformance,
} from '../_helpers/objects-conformance.js';

useObjectsConformance();

interface PutOptions {
  readonly at?: string;
  readonly tenantId?: string;
  readonly supersedesId?: number;
  readonly tags?: readonly string[];
  /** Set over the mirror core builds, for the reads that turn on a memory's own columns. */
  readonly mirror?: Partial<MemoryEntry>;
}

/** A save whose fields and mirror the caller picks, for the reads that turn on them. */
function put<K extends SavableKind>(kind: K, fields: ObjectFields[K], opts: PutOptions = {}) {
  const { at = T1, tenantId = TENANT_A } = opts;
  const mirror: MemoryEntry = {
    ...objectMirror(loadConfig(fixture.dir).defaultHalfLifeDays, tenantId, kind, {
      content: `${kind} at ${at}`,
      tags: opts.tags ?? [],
    }),
    ...opts.mirror,
  };
  const saved: ObjectSave<K> = { mirror, fields, supersedesId: opts.supersedesId, actor: ACTOR, at };
  const call: Call = (g) => {
    vi.setSystemTime(new Date(at));
    return g.saveObject(tenantId, kind, saved);
  };
  return { mirror, call };
}

describe('Objects, the policies in force at an instant', () => {
  const day = (monthDay: string): string => `2026-${monthDay}T00:00:00.000Z`;
  const policy = (policyName: string, from: string, to: string | null, opts: PutOptions = {}): Call =>
    put(
      'policy',
      {
        policyName,
        policyText: `${policyName} from ${from}`,
        validFrom: day(from),
        validTo: to === null ? null : day(to),
      },
      opts,
    ).call;
  const inForce =
    (asOf: string, more: { name?: string; limit?: number; tenantId?: string } = {}): Call =>
    async (g) =>
      (await g.policiesInForce(more.tenantId ?? TENANT_A, { asOf, name: more.name, limit: more.limit ?? 10 })).map(
        (p) => p.id,
      );
  /** Ids 1 to 7: 1 is replaced by 2 from June, 3 and 6 share a start, 4 is closed, 5 is the other tenant's and 7 starts in May under the name 3 holds. */
  const seed = (): Call[] => [
    policy('retention', '01-01', null),
    policy('retention', '06-01', null, { at: T2, supersedesId: 1 }),
    policy('access', '02-01', '04-01'),
    policy('export', '01-15', null),
    policy('retention', '01-01', null, { tenantId: TENANT_B }),
    policy('travel', '02-01', null),
    policy('access', '05-01', null),
    close('policy', 4, T3, ['active']),
  ];
  const SEEDED = 8;

  it('keeps a row from its start to its end, a replaced row until its successor starts, and never a closed or a foreign row', async () => {
    const side = await conforms([
      ...seed(),
      inForce(day('03-01')),
      inForce(day('07-01')),
      inForce('2025-12-31T23:59:59.999Z'),
      inForce(day('02-01')),
      inForce('2026-01-31T23:59:59.999Z'),
      inForce(day('04-01')),
      inForce('2026-03-31T23:59:59.999Z'),
      inForce(day('06-01')),
      inForce('2026-05-31T23:59:59.999Z'),
      inForce(day('03-01'), { tenantId: TENANT_B }),
      inForce('2025-12-31T23:59:59.999Z', { tenantId: TENANT_B }),
    ]);
    expect(side.outcomes.slice(SEEDED)).toEqual([
      { value: [6, 3, 1] },
      { value: [2, 7, 6] },
      { value: [] },
      { value: [6, 3, 1] },
      { value: [1] },
      { value: [6, 1] },
      { value: [6, 3, 1] },
      { value: [2, 7, 6] },
      { value: [7, 6, 1] },
      { value: [5] },
      { value: [] },
    ]);
    expect(
      added(side)
        .map((e) => e.op)
        .filter((op) => op !== 'policy_create' && op !== 'remember'),
    ).toEqual(['policy_supersede', 'policy_close']);
  });

  it('orders by the later start, then the larger id, under, at and over the cap, and keeps one name when asked', async () => {
    const side = await conforms([
      ...seed(),
      inForce(day('03-01'), { limit: 10 }),
      inForce(day('03-01'), { limit: 3 }),
      inForce(day('03-01'), { limit: 2 }),
      inForce(day('03-01'), { limit: 1 }),
      inForce(day('03-01'), { name: 'access' }),
      inForce(day('07-01'), { name: 'access' }),
      inForce(day('03-01'), { name: 'retention' }),
      inForce(day('07-01'), { name: 'retention' }),
      inForce(day('03-01'), { name: 'export' }),
      inForce(day('03-01'), { name: 'Access' }),
      inForce(day('03-01'), { name: '' }),
      (g) => g.policiesInForce(TENANT_A, { asOf: day('07-01'), name: 'retention', limit: 10 }),
    ]);
    expect(side.outcomes.slice(SEEDED, -1)).toEqual([
      { value: [6, 3, 1] },
      { value: [6, 3, 1] },
      { value: [6, 3] },
      { value: [6] },
      { value: [3] },
      { value: [7] },
      { value: [1] },
      { value: [2] },
      { value: [] },
      { value: [] },
      { value: [] },
    ]);
    expect(side.outcomes.at(-1)).toMatchObject({
      value: [
        {
          id: 2,
          tenantId: TENANT_A,
          policyName: 'retention',
          validFrom: day('06-01'),
          validTo: null,
          version: 2,
          status: 'active',
          supersededBy: null,
          createdAt: T2,
        },
      ],
    });
  });
});

describe('Objects, the active skills by name', () => {
  const skill = (name: string, opts: PutOptions = {}): Call =>
    put('skill', { name, instructions: `how to ${name}`, trigger: null }, opts).call;
  const names =
    (limit: number, tenantId = TENANT_A): Call =>
    async (g) =>
      (await g.activeSkillsByName(tenantId, limit)).map((s) => `${s.id} ${s.skillName}`);

  it('orders names by their bytes, then by id, under, at and over the cap, and leaves out a replaced, a closed and a foreign skill', async () => {
    // U+FF5A sorts below U+1F600 by bytes and above it by UTF-16 code unit, so the pair tells the two orders apart.
    const side = await conforms([
      skill('triage'),
      skill('Zebra'),
      skill('alpha'),
      skill('theirs', { tenantId: TENANT_B }),
      skill('alpha', { at: T2 }),
      skill('\u{1F600} wide'),
      skill('ｚ wide'),
      skill('retired'),
      skill('triage', { at: T3, supersedesId: 1 }),
      close('skill', 8, T3, ['active']),
      names(10),
      names(6),
      names(3),
      names(1),
      names(10, TENANT_B),
      (g) => g.activeSkillsByName(TENANT_A, 1),
    ]);
    const ordered = ['2 Zebra', '3 alpha', '5 alpha', '9 triage', '7 ｚ wide', '6 \u{1F600} wide'];
    expect(side.outcomes.slice(10, -1)).toEqual([
      { value: ordered },
      { value: ordered },
      { value: ordered.slice(0, 3) },
      { value: ['2 Zebra'] },
      { value: ['4 theirs'] },
    ]);
    expect(side.outcomes.at(-1)).toMatchObject({
      value: [
        {
          id: 2,
          tenantId: TENANT_A,
          skillName: 'Zebra',
          instructions: 'how to Zebra',
          trigger: null,
          version: 1,
          status: 'active',
        },
      ],
    });
  });
});

describe('Objects, the receipts a brief refresh cites', () => {
  const TAG = 'path:acme/web';
  const decision = (opts: PutOptions) => put('decision', { decisionText: 'noted', context: undefined }, opts);
  const receiptOf = (mirror: MemoryEntry): BriefReceipt => ({
    id: mirror.id,
    created: mirror.created,
    source: mirror.source,
    content: mirror.content,
  });
  const receipts =
    (tag: string, limit = 10, tenantId = TENANT_A): Call =>
    (g) =>
      g.briefReceipts(tenantId, tag, limit);
  /** Newest first, the larger id first on a shared instant. */
  const newestFirst = (mirrors: readonly MemoryEntry[]): BriefReceipt[] =>
    [...mirrors]
      .sort(
        (a, b) =>
          Buffer.compare(Buffer.from(b.created), Buffer.from(a.created)) ||
          Buffer.compare(Buffer.from(b.id), Buffer.from(a.id)),
      )
      .map(receiptOf);

  it('cites the memories that carry the whole tag, newest first, under, at and over the cap, and never a brief, a private scope or another tenant', async () => {
    const hits = [
      decision({ tags: [TAG], mirror: { created: T1 } }),
      decision({ tags: ['other', TAG], mirror: { created: T2 } }),
      decision({ tags: [TAG], mirror: { created: T2 } }),
      put(
        'customer_note',
        { customer: 'initech', note: 'prefers email' },
        { tags: ['PATH:Acme/Web'], mirror: { created: T3 } },
      ),
      decision({ tags: [TAG], mirror: { created: T3, scope: 'team:web' } }),
    ];
    const misses = [
      decision({ tags: ['path:acme/website'] }),
      decision({ tags: ['path:acme'] }),
      decision({ tags: [] }),
      put('project_brief', { repo: 'acme/web', summary: 'storefront', receiptCount: undefined }, { tags: [TAG] }),
      decision({ tags: [TAG], mirror: { scope: 'slack:private:C1' } }),
      decision({ tags: [TAG], mirror: { scope: 'unknown:legacy' } }),
    ];
    const theirs = decision({ tags: [TAG], tenantId: TENANT_B });
    const saves = [...hits, ...misses, theirs].map((p) => p.call);
    const side = await conforms([
      ...saves,
      receipts(TAG),
      receipts(TAG, 5),
      receipts(TAG, 2),
      receipts('PATH:ACME/WEB'),
      receipts(TAG, 10, TENANT_B),
      receipts('path:nowhere'),
    ]);
    const cited = newestFirst(hits.map((p) => p.mirror));
    expect(cited.map((r) => r.created)).toEqual([T3, T3, T2, T2, T1]);
    expect(side.outcomes.slice(saves.length)).toEqual([
      { value: cited },
      { value: cited },
      { value: cited.slice(0, 2) },
      { value: cited },
      { value: [receiptOf(theirs.mirror)] },
      { value: [] },
    ]);
  });

  it('matches the tag as written: a percent sign and an underscore stand for themselves, and only the ASCII letters fold', async () => {
    const tagged = (tag: string) => decision({ tags: [tag] });
    const [underscore, anyChar, percent, anyRun, accent, upperAccent, slashed] = [
      tagged('path:a_b'),
      tagged('path:axb'),
      tagged('path:100%'),
      tagged('path:100 percent'),
      tagged('path:café'),
      tagged('path:CAFÉ'),
      tagged('path:back\\slash'),
    ];
    const side = await conforms([
      ...[underscore, anyChar, percent, anyRun, accent, upperAccent, slashed].map((p) => p.call),
      receipts('path:a_b'),
      receipts('path:100%'),
      receipts('path:café'),
      receipts('path:CAFÉ'),
      receipts('path:%'),
      receipts('path:back\\slash'),
    ]);
    expect(side.outcomes.slice(7)).toEqual([
      { value: [receiptOf(underscore.mirror)] },
      { value: [receiptOf(percent.mirror)] },
      { value: [receiptOf(accent.mirror)] },
      { value: [receiptOf(upperAccent.mirror)] },
      // A backslash is written doubled in the stored tag list, so the tag as given never finds it.
      { value: [] },
      { value: [] },
    ]);
  });
});
