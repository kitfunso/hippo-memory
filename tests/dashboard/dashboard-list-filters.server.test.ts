// The memory list's native filters keep exactly the rows the JavaScript rules keep: the text test is hippo_holds_text's
// and the age brush is daysBetween's, on content, tags and created values built to sit on each edge of the SQL forms.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { daysBetween } from '../../src/base/memory/memory-facts.js';
import { closeHippoDb, openHippoDb, type SqlValue } from '../../src/db/index.js';
import { buildMemoryPage, type MemoryQuery } from '../../src/api/dashboard/queries.js';
import { HOLDS_TEXT, holdsTextBinds, useDashboardFunctions } from '../../src/store/sqlite/dashboard-functions.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { writeEntriesTogether } from '../_helpers/root-forms.js';
import { DAY, dashboardOf, makeStore, NOW, type TmpStore } from '../_helpers/dashboard-fixture.js';

const ROWS = 320;
// Pieces that sit on an edge: the two letters JavaScript lower-cases into ASCII, case past ASCII, JSON's escapes and
// String()'s ways with numbers, objects and nested lists.
const PIECES = ['ka', 'KA', 'k', '\u212a', 'i', 'I', '\u0130', '\u0307', 'é', 'É', 'Σ', 'σ', '日', ' ', '"', '\\'];
const MORE = ['\n', '\u0000', '1', '0', '.', '{', '[', ']', ',', 'a', 'b', 'object', '1e2', '100'];
const ALL_PIECES = [...PIECES, ...MORE];
const NEEDLES = [
  'ka',
  'k',
  'i',
  'i\u0307',
  'é',
  'σ',
  '日',
  '"',
  '\\',
  '\n',
  ' ',
  'a,b',
  'ka\nb',
  '100',
  '1.5',
  '[object',
  'object object',
  '"ka"',
  '{',
  'b"',
  'ka ka',
  '\u0000',
  'é日',
  'kKa',
];
const BRUSHES: ReadonlyArray<[number, number]> = [
  [-Infinity, Infinity],
  [0, Infinity],
  [-Infinity, 0],
  [0, 0],
  [-3, -1],
  [1, 30],
  [29.5, 30.25],
  [100, Infinity],
  [-Infinity, 365],
  [7, 7],
];
const BASE: MemoryQuery = {
  offset: 0,
  limit: 500,
  sort: 'content',
  dir: 'asc',
  chip: 'all',
  layers: [0, 1, 2, 3],
  brush: { amin: -Infinity, amax: Infinity, smin: -Infinity, smax: Infinity },
  q: null,
};

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rand: () => number, list: readonly T[]): T => list[Math.floor(rand() * list.length)];
const textOf = (rand: () => number, most: number): string =>
  Array.from({ length: Math.floor(rand() * most) }, () => pick(rand, ALL_PIECES)).join('');

// A tag list as another writer may have left it: escaped, holding numbers or lists, not a list, or not JSON.
function tagsJsonOf(rand: () => number, i: number): string {
  const tags = [textOf(rand, 4), textOf(rand, 4)];
  const escaped = (s: string): string =>
    s.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const forms = [
    JSON.stringify(tags),
    escaped(JSON.stringify(tags)),
    `["${pick(rand, ['ka', 'x'])}", 1e2, 1.50, -0, true, null]`,
    `[["ka", "b"], {"k": "a"}]`,
    '[ka',
    '[]',
    '"ka"',
    JSON.stringify([textOf(rand, 6)]),
  ];
  return forms[i % forms.length];
}

// Plain instants on and off whole days, and created text toISOString never writes.
function createdOf(rand: () => number, i: number): string {
  const odd = ['2026-02-30T00:00:00.000Z', '2026-09-30T24:00:00.000Z', '2026-09-01T00:00:00Z', '2026-09-01 10:00:00'];
  const more = ['not a date', '', '+012026-01-01T00:00:00.000Z', '2026-09-24T12:00:00.000+00:00'];
  if (i % 16 === 0) return [...odd, ...more][(i / 16) % 8];
  const days = i % 3 === 0 ? Math.round(rand() * 400) - 5 : rand() * 400 - 5;
  return new Date(NOW - Math.round(days * DAY)).toISOString();
}

let store: TmpStore;
let rows: Array<{ id: string; created: string }>;

beforeAll(() => {
  store = makeStore('hippo-dash-filters');
  const rand = rng(20261022);
  const ids = Array.from({ length: ROWS }, (_, i) => `mem_f${String(i).padStart(3, '0')}`);
  writeEntriesTogether(
    store.hippoRoot,
    ids.map((id) => ({ ...createMemory(`seed ${id}`, { tags: [] }), id, originProject: 'alpha' })),
  );
  rows = ids.map((id, i) => ({ id, created: createdOf(rand, i) }));
  const db = openHippoDb(store.hippoRoot);
  try {
    const update = db.prepare('UPDATE memories SET content = ?, tags_json = ?, created = ? WHERE id = ?');
    for (const [i, row] of rows.entries()) update.run(textOf(rand, 12), tagsJsonOf(rand, i), row.created, row.id);
  } finally {
    closeHippoDb(db);
  }
}, 60_000);

afterAll(() => {
  store.cleanup();
});

describe('dashboard list filters', () => {
  it('folds every letter past ASCII that JavaScript lower-cases into ASCII', () => {
    const letters: string[] = [];
    for (let code = 0x80; code <= 0x10ffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const letter = String.fromCodePoint(code);
      if ([...letter.toLowerCase()].some((c) => c.charCodeAt(0) < 0x80)) letters.push(letter);
    }
    expect(letters.length).toBeGreaterThan(0);
    const db = openHippoDb(store.hippoRoot);
    try {
      useDashboardFunctions(db, {});
      db.exec('CREATE TEMP TABLE letters (id TEXT, content TEXT, tags_json TEXT)');
      const insert = db.prepare('INSERT INTO temp.letters VALUES (?, ?, ?)');
      for (const [i, letter] of letters.entries()) insert.run(`l${i}`, `x${letter}y`, JSON.stringify([`x${letter}y`]));
      // SAFETY: COUNT(*) answers one row.
      const count = (sql: string, binds: Record<string, SqlValue>): number =>
        (db.prepare(`SELECT COUNT(*) AS n FROM temp.letters WHERE ${sql}`).get(binds) as { n: number }).n;
      for (const letter of letters) {
        // The ASCII run JavaScript's lower-casing leads with, such as xi from the dotted capital I.
        const needle = `x${letter}y`.toLowerCase().split(/[^\x20-\x7e]/)[0];
        const want = count('hippo_holds_text(id, content, tags_json, :text)', { text: needle });
        expect(want).toBeGreaterThan(0);
        expect(count(HOLDS_TEXT, { ...holdsTextBinds(needle) }), letter).toBe(want);
      }
    } finally {
      closeHippoDb(db);
    }
  });

  it('keeps the rows hippo_holds_text keeps, for every needle', () => {
    const db = openHippoDb(store.hippoRoot);
    try {
      useDashboardFunctions(db, {});
      const ids = (sql: string, binds: Record<string, SqlValue>): string[] =>
        (db.prepare(`SELECT id FROM memories WHERE ${sql} ORDER BY id`).all(binds) as Array<{ id: string }>).map(
          (r) => r.id,
        );
      const rand = rng(7);
      const needles = [...NEEDLES, ...Array.from({ length: 40 }, () => textOf(rand, 4) || 'ka')];
      for (const needle of [...needles, ...needles.map((n) => n.toLowerCase())]) {
        const want = ids('hippo_holds_text(id, content, tags_json, :text)', { text: needle });
        expect(ids(HOLDS_TEXT, { ...holdsTextBinds(needle) }), JSON.stringify(needle)).toEqual(want);
      }
    } finally {
      closeHippoDb(db);
    }
  });

  it('runs hippo_holds_text only on the rows that hold the needle once folded', () => {
    const plain = makeStore('hippo-dash-filters-plain');
    try {
      writeEntriesTogether(
        plain.hippoRoot,
        Array.from({ length: 60 }, (_, i) => ({
          ...createMemory(`note ${i} about ${i % 12 === 0 ? 'KAFKA' : 'redis'}`, { tags: ['ops'] }),
          originProject: 'alpha',
        })),
      );
      const db = openHippoDb(plain.hippoRoot);
      try {
        useDashboardFunctions(db, {});
        let calls = 0;
        // Four parameters, so it takes the place of the four-argument function the store registered.
        db.function('hippo_holds_text', { deterministic: true }, (_id, _content, _tags, _text) => {
          calls += 1;
          return 1;
        });
        const hits = db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${HOLDS_TEXT}`).get(holdsTextBinds('kafka'));
        expect(hits?.n).toBe(5);
        expect(calls).toBe(5);
      } finally {
        closeHippoDb(db);
      }
    } finally {
      plain.cleanup();
    }
  });

  it('keeps the rows daysBetween puts inside each age brush', async () => {
    const { reads, clock } = dashboardOf(store.hippoRoot, () => NOW);
    try {
      const stamp = await clock.at('default');
      const onEdges = rows.slice(1, 6).map((r) => daysBetween(r.created, NOW));
      const brushes: Array<[number, number]> = [...BRUSHES, ...onEdges.map((d): [number, number] => [d, d])];
      for (const [amin, amax] of brushes) {
        const page = await buildMemoryPage(reads, stamp, 'p:alpha', { ...BASE, brush: { ...BASE.brush, amin, amax } });
        const want = rows.filter((r) => {
          const age = daysBetween(r.created, NOW);
          return age >= amin && age <= amax;
        });
        expect(page?.total, `${amin} to ${amax}`).toBe(want.length);
        expect(page?.rows.map((r) => r.id).sort()).toEqual(want.map((r) => r.id).sort());
      }
    } finally {
      await reads.close();
    }
  });
});
