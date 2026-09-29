// planContainer and matchLegacy against plan design 6 and 10 (docs/plans/2026-09-29-import-agent-memories.md).
// Every expected value is read off the spec, not off plan.ts.
import { describe, expect, it, vi } from 'vitest';
import {
  planContainer,
  matchLegacy,
  type ContainerPlan,
  type DormantRow,
  type LegacyRow,
  type LegacyTarget,
  type LiveRow,
  type PlanItem,
} from '../src/agent-memories/plan.js';

const DAY1 = '2026-09-01T00:00:00.000Z';
const DAY2 = '2026-09-02T00:00:00.000Z';
const DAY3 = '2026-09-03T00:00:00.000Z';

const EMPTY: ContainerPlan = {
  unchanged: 0,
  retag: [],
  collapse: [],
  writes: [],
  restores: [],
  setAside: [],
  duplicates: 0,
  refused: 0,
};

const note = (key: string, hash: string): PlanItem => ({ key, hash, refused: false });
const refusedNote = (key: string, hash: string): PlanItem => ({ key, hash, refused: true });
const tagged = (id: string, key: string, hash: string, created = DAY1): LiveRow => ({ id, key, hash, tagged: true, created });
const untagged = (id: string, key: string, hash: string, created = DAY1): LiveRow => ({ id, key, hash, tagged: false, created });
const snapshot = (id: string, key: string, hash: string, dormantAt = DAY1): DormantRow => ({ id, key, hash, dormantAt });

interface Setup {
  readonly textKeyed?: boolean;
  readonly items?: readonly PlanItem[];
  readonly skipped?: readonly string[];
  readonly live?: readonly LiveRow[];
  readonly dormant?: readonly DormantRow[];
  readonly legacy?: ReadonlyMap<string, readonly string[]>;
  /** Keys whose text another path already stores live. */
  readonly dupes?: readonly string[];
}

interface Outcome {
  readonly plan: ContainerPlan;
  readonly asked: readonly string[];
}

interface PlanCase {
  readonly name: string;
  readonly setup: Setup;
  readonly want?: Partial<ContainerPlan>;
  /** Keys isDuplicate may be asked about: only those that would get a written row. */
  readonly asked?: readonly string[];
}

// The spec fixes no order inside a plan, so both sides are compared sorted.
function unordered(plan: ContainerPlan): ContainerPlan {
  return {
    ...plan,
    retag: [...plan.retag].sort(),
    collapse: [...plan.collapse].sort((a, b) => a.id.localeCompare(b.id)),
    writes: plan.writes
      .map((w) => ({ ...w, supersedes: [...w.supersedes].sort() }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    restores: [...plan.restores].sort((a, b) => a.key.localeCompare(b.key)),
    setAside: [...plan.setAside].sort(),
  };
}

function run(setup: Setup): Outcome {
  const dupes = new Set(setup.dupes ?? []);
  const isDuplicate = vi.fn((item: PlanItem) => dupes.has(item.key));
  const plan = planContainer({
    textKeyed: setup.textKeyed ?? false,
    items: setup.items ?? [],
    skipped: setup.skipped ?? [],
    live: setup.live ?? [],
    dormant: setup.dormant ?? [],
    legacy: setup.legacy,
    isDuplicate,
  });
  return { plan: unordered(plan), asked: isDuplicate.mock.calls.map(([item]) => item.key).sort() };
}

function check(c: PlanCase): void {
  const { plan, asked } = run(c.setup);
  expect(plan).toEqual(unordered({ ...EMPTY, ...c.want }));
  expect(asked).toEqual([...(c.asked ?? [])].sort());
}

const keptCases: readonly PlanCase[] = [
  {
    name: 'keeps the one tagged row whose hash matches and counts it unchanged',
    setup: { items: [note('k', 'new')], live: [tagged('r1', 'k', 'new')] },
    want: { unchanged: 1 },
  },
  {
    name: 'collapses two tagged rows with the item hash into the one created later',
    setup: { items: [note('k', 'new')], live: [tagged('r1', 'k', 'new', DAY2), tagged('r2', 'k', 'new', DAY1)] },
    want: { collapse: [{ id: 'r2', by: 'r1' }] },
  },
  {
    name: 'breaks a created tie between tagged rows by the larger id',
    setup: { items: [note('k', 'new')], live: [tagged('r1', 'k', 'new'), tagged('r2', 'k', 'new')] },
    want: { collapse: [{ id: 'r1', by: 'r2' }] },
  },
  {
    name: 'collapses a newer tagged row with an old hash into the row that matches',
    setup: { items: [note('k', 'new')], live: [tagged('r1', 'k', 'new', DAY1), tagged('r2', 'k', 'old', DAY3)] },
    want: { collapse: [{ id: 'r2', by: 'r1' }] },
  },
  {
    name: 'prefers a tagged match over a newer untagged match and leaves the untagged one alone',
    setup: { items: [note('k', 'new')], live: [tagged('r1', 'k', 'new', DAY1), untagged('r2', 'k', 'new', DAY2)] },
    want: { unchanged: 1 },
  },
  {
    name: 'leaves a restored untagged row with an old hash alone while the tagged row stays unchanged',
    setup: { items: [note('k', 'new')], live: [tagged('r1', 'k', 'new'), untagged('r2', 'k', 'old', DAY2)] },
    want: { unchanged: 1 },
  },
  {
    name: 'puts the tag back on an untagged row with the current hash when no tagged row has it',
    setup: { items: [note('k', 'new')], live: [untagged('r1', 'k', 'new')] },
    want: { retag: ['r1'] },
  },
  {
    name: 'retags the untagged match, collapses tagged rows into it and leaves other untagged rows',
    setup: {
      items: [note('k', 'new')],
      live: [untagged('r1', 'k', 'new'), tagged('r2', 'k', 'old', DAY2), untagged('r3', 'k', 'older')],
    },
    want: { retag: ['r1'], collapse: [{ id: 'r2', by: 'r1' }] },
  },
];

const changedCases: readonly PlanCase[] = [
  {
    name: 'writes the new row and supersedes the tagged row of the old hash',
    setup: { items: [note('k', 'new')], live: [tagged('r1', 'k', 'old')] },
    want: { writes: [{ key: 'k', hash: 'new', supersedes: ['r1'] }] },
    asked: ['k'],
  },
  {
    name: 'supersedes every live row of the key, tagged and untagged, when the note changed',
    setup: {
      items: [note('k', 'new')],
      live: [tagged('r1', 'k', 'old'), untagged('r2', 'k', 'older'), tagged('r3', 'k', 'older')],
    },
    want: { writes: [{ key: 'k', hash: 'new', supersedes: ['r1', 'r2', 'r3'] }] },
    asked: ['k'],
  },
  {
    name: 'supersedes a lone untagged row when the note changed after a restore',
    setup: { items: [note('k', 'new')], live: [untagged('r1', 'k', 'old')] },
    want: { writes: [{ key: 'k', hash: 'new', supersedes: ['r1'] }] },
    asked: ['k'],
  },
  {
    name: 'adds the legacy rows of the key to what the new row supersedes',
    setup: { items: [note('k', 'new')], live: [tagged('r1', 'k', 'old')], legacy: new Map([['k', ['L1']]]) },
    want: { writes: [{ key: 'k', hash: 'new', supersedes: ['L1', 'r1'] }] },
    asked: ['k'],
  },
  {
    name: 'writes rather than restores while a live row exists, even if a snapshot has the hash',
    setup: { items: [note('k', 'new')], live: [tagged('r1', 'k', 'old')], dormant: [snapshot('s1', 'k', 'new')] },
    want: { writes: [{ key: 'k', hash: 'new', supersedes: ['r1'] }] },
    asked: ['k'],
  },
];

const freshCases: readonly PlanCase[] = [
  {
    name: 'restores the snapshot with the item hash when the key has no live row',
    setup: { items: [note('k', 'new')], dormant: [snapshot('s1', 'k', 'new')] },
    want: { restores: [{ key: 'k', dormantId: 's1' }] },
  },
  {
    name: 'restores the matching snapshot set aside most recently',
    setup: { items: [note('k', 'new')], dormant: [snapshot('s1', 'k', 'new', DAY2), snapshot('s2', 'k', 'new', DAY1)] },
    want: { restores: [{ key: 'k', dormantId: 's1' }] },
  },
  {
    name: 'breaks a dormant time tie by the larger id',
    setup: { items: [note('k', 'new')], dormant: [snapshot('s1', 'k', 'new'), snapshot('s2', 'k', 'new')] },
    want: { restores: [{ key: 'k', dormantId: 's2' }] },
  },
  {
    name: 'passes over a newer snapshot with another hash to restore the matching one',
    setup: { items: [note('k', 'new')], dormant: [snapshot('s1', 'k', 'new', DAY1), snapshot('s2', 'k', 'old', DAY3)] },
    want: { restores: [{ key: 'k', dormantId: 's1' }] },
  },
  {
    name: 'writes a fresh row when only snapshots with other hashes exist',
    setup: { items: [note('k', 'new')], dormant: [snapshot('s1', 'k', 'old')] },
    want: { writes: [{ key: 'k', hash: 'new', supersedes: [] }] },
    asked: ['k'],
  },
  {
    name: 'writes a fresh row when the matching snapshot belongs to another key',
    setup: { items: [note('k', 'new')], dormant: [snapshot('s1', 'j', 'new')] },
    want: { writes: [{ key: 'k', hash: 'new', supersedes: [] }] },
    asked: ['k'],
  },
  {
    name: 'writes a fresh row on first import',
    setup: { items: [note('k', 'new')] },
    want: { writes: [{ key: 'k', hash: 'new', supersedes: [] }] },
    asked: ['k'],
  },
  {
    name: 'lets a fresh row supersede the legacy rows of its key',
    setup: { items: [note('k', 'new')], legacy: new Map([['k', ['L1', 'L2']]]) },
    want: { writes: [{ key: 'k', hash: 'new', supersedes: ['L1', 'L2'] }] },
    asked: ['k'],
  },
];

const absentCases: readonly PlanCase[] = [
  {
    name: 'refused: counts it and sets aside every tagged row, even one with the item hash',
    setup: {
      items: [refusedNote('k', 'new')],
      live: [tagged('r1', 'k', 'new'), tagged('r2', 'k', 'old'), untagged('r3', 'k', 'old')],
    },
    want: { refused: 1, setAside: ['r1', 'r2'] },
  },
  {
    name: 'refused with no rows only counts the refusal',
    setup: { items: [refusedNote('k', 'new')] },
    want: { refused: 1 },
  },
  {
    name: 'refused does not bring back a snapshot with its hash',
    setup: { items: [refusedNote('k', 'new')], dormant: [snapshot('s1', 'k', 'new')] },
    want: { refused: 1 },
  },
  {
    name: 'unread: leaves every row of the key alone',
    setup: { skipped: ['k'], live: [tagged('r1', 'k', 'old'), untagged('r2', 'k', 'old')] },
  },
  {
    name: 'gone: sets aside every tagged row and leaves the untagged ones',
    setup: { live: [tagged('r1', 'k', 'old'), tagged('r2', 'k', 'new'), untagged('r3', 'k', 'old')] },
    want: { setAside: ['r1', 'r2'] },
  },
  {
    name: 'gone with only untagged rows changes nothing',
    setup: { live: [untagged('r1', 'k', 'old')] },
  },
];

const duplicateCases: readonly PlanCase[] = [
  {
    name: 'a duplicate with live rows writes nothing, sets aside the tagged rows and is counted',
    setup: { items: [note('k', 'new')], live: [tagged('r1', 'k', 'old'), untagged('r2', 'k', 'older')], dupes: ['k'] },
    want: { setAside: ['r1'], duplicates: 1 },
    asked: ['k'],
  },
  {
    name: 'a duplicate with no live row is only counted',
    setup: { items: [note('k', 'new')], dupes: ['k'] },
    want: { duplicates: 1 },
    asked: ['k'],
  },
  {
    name: 'a kept row is never checked for a duplicate',
    setup: { items: [note('k', 'new')], live: [tagged('r1', 'k', 'new')], dupes: ['k'] },
    want: { unchanged: 1 },
  },
  {
    name: 'a restore is never checked for a duplicate',
    setup: { items: [note('k', 'new')], dormant: [snapshot('s1', 'k', 'new')], dupes: ['k'] },
    want: { restores: [{ key: 'k', dormantId: 's1' }] },
  },
  {
    name: 'a refused item is never checked for a duplicate',
    setup: { items: [refusedNote('k', 'new')], live: [tagged('r1', 'k', 'old')], dupes: ['k'] },
    want: { refused: 1, setAside: ['r1'] },
  },
  {
    name: 'a gone key is never checked for a duplicate',
    setup: { live: [tagged('r1', 'k', 'old')], dupes: ['k'] },
    want: { setAside: ['r1'] },
  },
];

const OLD = 'prefs/aaaaaaaaaaaa';
const OLD_TOO = 'prefs/cccccccccccc';
const NEW = 'prefs/bbbbbbbbbbbb';
const NEW_TWIN = 'prefs/bbbbbbbbbbbb~2';
const NEW_TOO = 'prefs/ffffffffffff';
const TIPS_OLD = 'tips/eeeeeeeeeeee';
const TIPS_NEW = 'tips/dddddddddddd';

const editCases: readonly PlanCase[] = [
  {
    name: 'reads one gone key and one new key under a heading as an edit',
    setup: { textKeyed: true, items: [note(NEW, 'hb')], live: [tagged('g1', OLD, 'ha')] },
    want: { writes: [{ key: NEW, hash: 'hb', supersedes: ['g1'] }] },
    asked: [NEW],
  },
  {
    name: 'takes the heading of a ~2 key from before its last slash',
    setup: { textKeyed: true, items: [note(NEW_TWIN, 'hb')], live: [tagged('g1', OLD, 'ha')] },
    want: { writes: [{ key: NEW_TWIN, hash: 'hb', supersedes: ['g1'] }] },
    asked: [NEW_TWIN],
  },
  {
    name: 'hands every tagged row of the gone key to the new row and leaves its untagged row',
    setup: {
      textKeyed: true,
      items: [note(NEW, 'hb')],
      live: [tagged('g1', OLD, 'ha'), tagged('g2', OLD, 'ha', DAY2), untagged('u1', OLD, 'ha')],
    },
    want: { writes: [{ key: NEW, hash: 'hb', supersedes: ['g1', 'g2'] }] },
    asked: [NEW],
  },
  {
    name: 'two gone keys and one new key give set-asides and a plain write',
    setup: { textKeyed: true, items: [note(NEW, 'hb')], live: [tagged('g1', OLD, 'ha'), tagged('g2', OLD_TOO, 'hc')] },
    want: { setAside: ['g1', 'g2'], writes: [{ key: NEW, hash: 'hb', supersedes: [] }] },
    asked: [NEW],
  },
  {
    name: 'one gone key and two new keys give a set-aside and plain writes',
    setup: { textKeyed: true, items: [note(NEW, 'hb'), note(NEW_TOO, 'hf')], live: [tagged('g1', OLD, 'ha')] },
    want: {
      setAside: ['g1'],
      writes: [
        { key: NEW, hash: 'hb', supersedes: [] },
        { key: NEW_TOO, hash: 'hf', supersedes: [] },
      ],
    },
    asked: [NEW, NEW_TOO],
  },
  {
    name: 'a gone key and a new key under different headings are not an edit',
    setup: { textKeyed: true, items: [note(TIPS_NEW, 'hd')], live: [tagged('g1', OLD, 'ha')] },
    want: { setAside: ['g1'], writes: [{ key: TIPS_NEW, hash: 'hd', supersedes: [] }] },
    asked: [TIPS_NEW],
  },
  {
    name: 'a store not keyed by text never pairs a gone key with a new one',
    setup: { textKeyed: false, items: [note(NEW, 'hb')], live: [tagged('g1', OLD, 'ha')] },
    want: { setAside: ['g1'], writes: [{ key: NEW, hash: 'hb', supersedes: [] }] },
    asked: [NEW],
  },
  {
    name: 'a new key that comes back from a snapshot is not an edit',
    setup: { textKeyed: true, items: [note(NEW, 'hb')], live: [tagged('g1', OLD, 'ha')], dormant: [snapshot('s1', NEW, 'hb')] },
    want: { setAside: ['g1'], restores: [{ key: NEW, dormantId: 's1' }] },
  },
  {
    name: 'a new key whose text is already stored is not an edit',
    setup: { textKeyed: true, items: [note(NEW, 'hb')], live: [tagged('g1', OLD, 'ha')], dupes: [NEW] },
    want: { setAside: ['g1'], duplicates: 1 },
    asked: [NEW],
  },
  {
    name: 'a gone key with only untagged rows does not stop the pairing',
    setup: { textKeyed: true, items: [note(NEW, 'hb')], live: [tagged('g1', OLD, 'ha'), untagged('u1', OLD_TOO, 'hc')] },
    want: { writes: [{ key: NEW, hash: 'hb', supersedes: ['g1'] }] },
    asked: [NEW],
  },
  {
    name: 'an unread key under the heading does not stop the pairing',
    setup: {
      textKeyed: true,
      items: [note(NEW, 'hb')],
      skipped: [OLD_TOO],
      live: [tagged('g1', OLD, 'ha'), tagged('g2', OLD_TOO, 'hc')],
    },
    want: { writes: [{ key: NEW, hash: 'hb', supersedes: ['g1'] }] },
    asked: [NEW],
  },
  {
    name: 'pairs each heading on its own',
    setup: {
      textKeyed: true,
      items: [note(NEW, 'hb'), note(TIPS_NEW, 'hd')],
      live: [tagged('g1', OLD, 'ha'), tagged('g3', TIPS_OLD, 'he')],
    },
    want: {
      writes: [
        { key: NEW, hash: 'hb', supersedes: ['g1'] },
        { key: TIPS_NEW, hash: 'hd', supersedes: ['g3'] },
      ],
    },
    asked: [NEW, TIPS_NEW],
  },
];

describe('planContainer: present item with a live row of its hash', () => {
  it.each(keptCases)('$name', (c) => check(c));
});

describe('planContainer: present item whose note changed', () => {
  it.each(changedCases)('$name', (c) => check(c));
});

describe('planContainer: present item with no live row', () => {
  it.each(freshCases)('$name', (c) => check(c));
});

describe('planContainer: refused, unread and gone items', () => {
  it.each(absentCases)('$name', (c) => check(c));
});

describe('planContainer: text already stored by another path', () => {
  it.each(duplicateCases)('$name', (c) => check(c));
});

describe('planContainer: single-file edits', () => {
  it.each(editCases)('$name', (c) => check(c));
});

describe('planContainer: whole container', () => {
  it('gives an all-empty plan for an empty container with no rows', () => {
    expect(run({})).toEqual({ plan: EMPTY, asked: [] });
  });

  it('gives an all-empty plan when only snapshots exist', () => {
    expect(run({ dormant: [snapshot('s1', 'k', 'new')] })).toEqual({ plan: EMPTY, asked: [] });
  });

  it('plans each key on its own within one container', () => {
    check({
      name: 'mixed',
      setup: {
        items: [note('a', 'a1'), note('b', 'b2'), note('e', 'e1'), refusedNote('f', 'f1'), note('g', 'g1')],
        skipped: ['d'],
        live: [
          tagged('a1', 'a', 'a1'),
          tagged('b1', 'b', 'b1'),
          tagged('c1', 'c', 'c1'),
          untagged('c2', 'c', 'c0'),
          tagged('d1', 'd', 'd1'),
          tagged('f1', 'f', 'f0'),
        ],
        dormant: [snapshot('s1', 'g', 'g1')],
      },
      want: {
        unchanged: 1,
        writes: [
          { key: 'b', hash: 'b2', supersedes: ['b1'] },
          { key: 'e', hash: 'e1', supersedes: [] },
        ],
        restores: [{ key: 'g', dormantId: 's1' }],
        setAside: ['c1', 'f1'],
        refused: 1,
      },
      asked: ['b', 'e'],
    });
  });
});

describe('planContainer: one key across syncs', () => {
  it('follows a note from A to B and back to A, each write superseding the last', () => {
    const first = run({ items: [note('k', 'hA')] });
    expect(first.plan).toEqual({ ...EMPTY, writes: [{ key: 'k', hash: 'hA', supersedes: [] }] });
    const second = run({ items: [note('k', 'hB')], live: [tagged('w1', 'k', 'hA', DAY1)] });
    expect(second.plan).toEqual({ ...EMPTY, writes: [{ key: 'k', hash: 'hB', supersedes: ['w1'] }] });
    // w1 was superseded by the second write, so only w2 is live for the third call.
    const third = run({ items: [note('k', 'hA')], live: [tagged('w2', 'k', 'hB', DAY2)] });
    expect(third.plan).toEqual({ ...EMPTY, writes: [{ key: 'k', hash: 'hA', supersedes: ['w2'] }] });
    expect([first.asked, second.asked, third.asked]).toEqual([['k'], ['k'], ['k']]);
  });

  it('sets a deleted note aside, then restores that snapshot when the note comes back', () => {
    const deleted = run({ live: [tagged('w1', 'k', 'hA')] });
    expect(deleted).toEqual({ plan: { ...EMPTY, setAside: ['w1'] }, asked: [] });
    const back = run({ items: [note('k', 'hA')], dormant: [snapshot('w1', 'k', 'hA', DAY2)] });
    expect(back).toEqual({ plan: { ...EMPTY, restores: [{ key: 'k', dormantId: 'w1' }] }, asked: [] });
  });

  it('keeps a restored row unchanged on the next sync', () => {
    const next = run({ items: [note('k', 'hA')], live: [tagged('w1', 'k', 'hA')] });
    expect(next).toEqual({ plan: { ...EMPTY, unchanged: 1 }, asked: [] });
  });
});

const legacyRow = (id: string, file: string, textKey: string): LegacyRow => ({ id, file, textKey });
const target = (ref: string, file: string, textKey: string): LegacyTarget => ({ ref, file, textKey });

interface LegacyCase {
  readonly name: string;
  readonly rows: readonly LegacyRow[];
  readonly targets: readonly LegacyTarget[];
  /** [legacy id, target ref] pairs. */
  readonly adopt?: readonly (readonly [string, string])[];
  /** [target ref, legacy id] pairs. */
  readonly replace?: readonly (readonly [string, string])[];
}

const legacyCases: readonly LegacyCase[] = [
  {
    name: 'adopts a legacy row whose text matches a note of the same file',
    rows: [legacyRow('L1', 'a.md', 'x')],
    targets: [target('t1', 'a.md', 'x')],
    adopt: [['L1', 't1']],
  },
  {
    name: 'adopts a renamed note: same text under another file name',
    rows: [legacyRow('L1', 'old.md', 'x')],
    targets: [target('t1', 'new.md', 'x')],
    adopt: [['L1', 't1']],
  },
  {
    name: 'gives a text several notes share to the first target in order',
    rows: [legacyRow('L1', 'a.md', 'x')],
    targets: [target('tB', 'b.md', 'x'), target('tA', 'a.md', 'x')],
    adopt: [['L1', 'tB']],
  },
  {
    name: 'adopts every legacy row that has the text',
    rows: [legacyRow('L1', 'a.md', 'x'), legacyRow('L2', 'b.md', 'x')],
    targets: [target('t1', 'a.md', 'x')],
    adopt: [
      ['L1', 't1'],
      ['L2', 't1'],
    ],
  },
  {
    name: 'replaces the one legacy row of a file whose text changed',
    rows: [legacyRow('L1', 'a.md', 'x')],
    targets: [target('t1', 'a.md', 'y')],
    replace: [['t1', 'L1']],
  },
  {
    name: 'leaves two legacy rows of one file with different text untouched',
    rows: [legacyRow('L1', 'a.md', 'x'), legacyRow('L2', 'a.md', 'y')],
    targets: [target('t1', 'a.md', 'z')],
  },
  {
    name: 'leaves one legacy row untouched when two notes share its file name',
    rows: [legacyRow('L1', 'a.md', 'x')],
    targets: [target('t1', 'a.md', 'y'), target('t2', 'a.md', 'z')],
  },
  {
    name: 'does not reuse a target adopted in the first round for a replace',
    rows: [legacyRow('L1', 'a.md', 'x'), legacyRow('L2', 'a.md', 'y')],
    targets: [target('t1', 'a.md', 'x')],
    adopt: [['L1', 't1']],
  },
  {
    name: 'replaces with the one target of the file left after adoption',
    rows: [legacyRow('L1', 'a.md', 'x'), legacyRow('L2', 'a.md', 'y')],
    targets: [target('t1', 'a.md', 'x'), target('t2', 'a.md', 'z')],
    adopt: [['L1', 't1']],
    replace: [['t2', 'L2']],
  },
  {
    name: 'counts only unadopted legacy rows of a file in the second round',
    rows: [legacyRow('L1', 'a.md', 'x'), legacyRow('L2', 'a.md', 'y')],
    targets: [target('t1', 'b.md', 'x'), target('t2', 'a.md', 'z')],
    adopt: [['L1', 't1']],
    replace: [['t2', 'L2']],
  },
  {
    name: 'leaves a legacy row untouched when no note has its file name',
    rows: [legacyRow('L1', 'gone.md', 'x')],
    targets: [target('t1', 'a.md', 'y')],
  },
  {
    name: 'returns nothing when there are no legacy rows',
    rows: [],
    targets: [target('t1', 'a.md', 'x')],
  },
];

const byFirst = (pairs: Iterable<readonly [string, string]>) => [...pairs].sort((a, b) => a[0].localeCompare(b[0]));

describe('matchLegacy', () => {
  it.each(legacyCases)('$name', (c) => {
    const match = matchLegacy(c.rows, c.targets);
    expect(byFirst(match.adopt)).toEqual(byFirst(c.adopt ?? []));
    expect(byFirst(match.replace)).toEqual(byFirst(c.replace ?? []));
  });
});
