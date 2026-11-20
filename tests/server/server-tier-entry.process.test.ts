// What hippo-enterprise imports from the server and store-kit entries gives the answers the core code does, called by package name from a child against the build.
import { readdirSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeRoot, makeStore, openStoreAt } from '../_helpers/make-root.js';
import { runModuleScript } from '../_helpers/run-module-script.js';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type KitAnswers = { [label: string]: Json };

/** The named store-kit exports, each called with its JSON arguments, or read when it is a value. */
function callKit(calls: { [label: string]: readonly [name: string, ...args: Json[]] }): KitAnswers {
  const script = `
    const kit = await import('hippo-memory/store-kit');
    const out = {};
    for (const [label, [name, ...args]] of Object.entries(JSON.parse(process.argv[1]))) {
      out[label] = typeof kit[name] === 'function' ? kit[name](...args) : kit[name];
    }
    console.log(JSON.stringify(out));
  `;
  return runModuleScript<KitAnswers>(script, JSON.stringify(calls));
}

/** One column of the row `id` on the store at `root`, which the SQL names `value`; read through the helper that check-test-stores allows. */
function stored<T extends number | string>(root: string, sql: string, id: string): T {
  const db = openStoreAt(root);
  try {
    // SAFETY: each caller selects a column of a row it seeded, as `value`, and names its type.
    return (db.prepare(sql).get(id) as { value: T }).value;
  } finally {
    db.close();
  }
}

describe('hippo-memory/store-kit initStore', () => {
  it('makes hippo.db in a folder that is no store yet, with no rows', () => {
    const root = makeRoot('server-tier-init', { init: false });
    const script = `
      import { existsSync, readdirSync } from 'node:fs';
      import { join } from 'node:path';
      import { ALL_TENANTS, initStore, sqliteStore } from 'hippo-memory/store-kit';
      const root = process.argv[1];
      const before = readdirSync(root);
      initStore(root);
      // Read before sqliteStore opens the folder, because that open makes the same files.
      const made = { db: existsSync(join(root, 'hippo.db')), files: readdirSync(root).sort() };
      const store = sqliteStore(root);
      const page = await store.entriesWhere({ tenantId: ALL_TENANTS }, { limit: 10 });
      await store.close();
      console.log(JSON.stringify({ before, made, rows: page.entries }));
    `;
    const answer = runModuleScript<{ before: string[]; made: { db: boolean; files: string[] }; rows: unknown[] }>(
      script,
      root,
    );
    expect(answer.before).not.toContain('hippo.db');
    expect(answer.made.db).toBe(true);
    expect(answer.made.files).toEqual(readdirSync(root).sort());
    expect(answer.rows).toEqual([]);
  });
});

describe('hippo-memory/server embedAll', () => {
  // The index branch is hippo.db's own; the store branch is what a store with only vector groups, as the Postgres one, gets.
  it.each(['index', 'store'] as const)('embeds each memory once on the %s target', (branch) => {
    const { root } = makeStore(`server-tier-embed-${branch}`);
    const script = `
      import { embedAll, folderIndex } from 'hippo-memory/server';
      import { loadConfig, sqliteStore } from 'hippo-memory/store-kit';
      import { writeEntry } from 'hippo-memory/testing';
      import { createMemory } from 'hippo-memory';
      const [root, branch] = process.argv.slice(1);
      for (const text of ['alpha note', 'beta note', 'gamma note']) writeEntry(root, createMemory(text));
      const stub = {
        kind: 'local', model: 'stub', id: 'stub', isAvailable: () => true,
        embed: async (texts) => texts.map(() => [0.1, 0.2, 0.3, 0.4]),
      };
      const store = sqliteStore(root);
      const onlyGroups = { ...store, embeddingIndex: undefined };
      const target = folderIndex({ store: branch === 'store' ? onlyGroups : store, config: loadConfig(root) });
      const first = await embedAll(target, undefined, stub);
      const second = await embedAll(target, undefined, stub);
      await store.close();
      console.log(JSON.stringify({ reached: 'groups' in target ? 'store' : 'index', first, second }));
    `;
    expect(runModuleScript(script, root, branch)).toEqual({ reached: branch, first: 3, second: 0 });
  });
});

describe('store-kit row rules answer as core does', () => {
  it('duplicateHash is the hash core stores on a row it writes', () => {
    const { root } = makeStore('server-tier-hash');
    const script = `
      import { duplicateHash } from 'hippo-memory/store-kit';
      import { writeEntry } from 'hippo-memory/testing';
      import { createMemory } from 'hippo-memory';
      const entry = createMemory('  Rotate the   API keys\\n every month ');
      writeEntry(process.argv[1], entry);
      console.log(JSON.stringify({
        id: entry.id,
        hash: duplicateHash(entry.content),
        spaced: duplicateHash('Rotate the API keys every month'),
      }));
    `;
    const { id, hash, spaced } = runModuleScript<{ id: string; hash: number; spaced: number }>(script, root);
    expect(stored<number>(root, 'SELECT duplicate_hash AS value FROM memories WHERE id = ?', id)).toBe(hash);
    expect(spaced).toBe(hash);
  });

  it('isoInstant matches the created stamp core stores, which keeps a stamp it cannot read as sent', () => {
    const { root } = makeStore('server-tier-stamp');
    const script = `
      import { isoInstant } from 'hippo-memory/store-kit';
      import { writeEntry } from 'hippo-memory/testing';
      import { createMemory } from 'hippo-memory';
      const rows = [];
      for (const stamp of JSON.parse(process.argv[2])) {
        const entry = { ...createMemory('stamped ' + stamp), created: stamp };
        writeEntry(process.argv[1], entry);
        rows.push({ id: entry.id, stamp, iso: isoInstant(stamp) });
      }
      console.log(JSON.stringify(rows));
    `;
    const stamps = ['2026-03-05T10:00:00+02:00', 'not a date'];
    const rows = runModuleScript<Array<{ id: string; stamp: string; iso: string | null }>>(
      script,
      root,
      JSON.stringify(stamps),
    );
    for (const { id, stamp, iso } of rows) {
      expect(stored<string>(root, 'SELECT created AS value FROM memories WHERE id = ?', id)).toBe(iso ?? stamp);
    }
    // An explicit offset makes this one the same instant in every time zone.
    expect(rows.map((r) => r.iso)).toEqual(['2026-03-05T08:00:00.000Z', null]);
  });

  it('entryAfterOutcome scores at the `now` it is given, as a store with that clock does', () => {
    const { root } = makeStore('server-tier-outcome');
    const script = `
      import { entryAfterOutcome, sqliteStore } from 'hippo-memory/store-kit';
      import { writeEntry } from 'hippo-memory/testing';
      import { createMemory } from 'hippo-memory';
      const root = process.argv[1];
      const entry = createMemory('deploys go out on tuesdays');
      writeEntry(root, entry);
      const now = new Date(Date.parse(entry.created) + 30 * 86_400_000);
      const store = sqliteStore(root, { lossAversionRatio: 2, fakeNowMs: now.getTime() });
      const [before] = await store.entriesByIds([entry.id], 'default');
      const atNow = entryAfterOutcome(before, false, { lossAversionRatio: 2, now });
      const atWallClock = entryAfterOutcome(before, false, { lossAversionRatio: 2 });
      const target = { tenantId: 'default', actor: 'test', ownScope: null, role: 'admin' };
      await store.entryWrites.applyOutcome({ ...target, ids: [entry.id], good: false });
      const [after] = await store.entriesByIds([entry.id], 'default');
      await store.close();
      console.log(JSON.stringify({ stored: after.strength, atNow: atNow.strength, atWallClock: atWallClock.strength }));
    `;
    const { stored, atNow, atWallClock } = runModuleScript<{ stored: number; atNow: number; atWallClock: number }>(
      script,
      root,
    );
    expect(stored).toBe(atNow);
    // Without the given clock the strength would differ, so the match above is the clock at work.
    expect(atNow).not.toBe(atWallClock);
  });

  it('auditRowsRead is the count of rows listAuditEvents reads from a store with more rows than the cap', () => {
    const { root } = makeStore('server-tier-audit');
    const script = `
      import { auditRowsRead, sqliteStore } from 'hippo-memory/store-kit';
      const store = sqliteStore(process.argv[1]);
      const events = Array.from({ length: 10_100 }, (_, i) => ({
        tenantId: 'default', actor: 'cli', op: 'remember', targetId: 'mem_' + i,
      }));
      await store.appendAuditEvents(events);
      const rows = [];
      for (const limit of [undefined, 0, 5, 10_000, 10_001, 50_000]) {
        const read = await store.auditLog.listAuditEvents({ tenantId: 'default', limit });
        rows.push({ limit: limit ?? null, expected: auditRowsRead(limit), actual: read.length });
      }
      await store.close();
      console.log(JSON.stringify(rows));
    `;
    const rows = runModuleScript<Array<{ limit: number | null; expected: number; actual: number }>>(script, root);
    expect(rows.map((r) => r.actual)).toEqual(rows.map((r) => r.expected));
    // The default, the floor of 1, a plain limit, then the cap of 10,000 plus the one row read ahead.
    expect(rows.map((r) => r.expected)).toEqual([100, 1, 5, 10_000, 10_001, 10_001]);
  });

  it('RawAppendOnlyError is the class a forget of a raw row rejects with', () => {
    const { root } = makeStore('server-tier-raw');
    const script = `
      import { RawAppendOnlyError, sqliteStore } from 'hippo-memory/store-kit';
      import { writeEntry } from 'hippo-memory/testing';
      import { Layer, createMemory } from 'hippo-memory';
      const root = process.argv[1];
      const raw = createMemory('raw chat line about the staging move', { kind: 'raw', layer: Layer.Buffer });
      writeEntry(root, raw);
      const store = sqliteStore(root);
      const target = { tenantId: 'default', actor: 'test', ownScope: null, role: 'admin', id: raw.id };
      const outcome = await store.entryWrites.forget(target).then(
        () => 'kept',
        (err) => ({ isRawAppendOnly: err instanceof RawAppendOnlyError, message: err.message }),
      );
      await store.close();
      console.log(JSON.stringify({ outcome }));
    `;
    expect(runModuleScript(script, root)).toEqual({
      outcome: { isRawAppendOnly: true, message: 'raw is append-only' },
    });
  });
});

describe('store-kit search helpers answer as the SQLite search does', () => {
  it('interleaveRows orders two lists as searchRecallEntries does for a word term and a CJK term', () => {
    const { root } = makeStore('server-tier-interleave');
    const script = `
      import { interleaveRows, sqliteStore } from 'hippo-memory/store-kit';
      import { writeEntry } from 'hippo-memory/testing';
      import { createMemory } from 'hippo-memory';
      const [root, json] = process.argv.slice(1);
      const { texts, query, wordQuery, cjkQuery, limits } = JSON.parse(json);
      const ids = texts.map((text) => {
        const entry = createMemory(text);
        writeEntry(root, entry);
        return entry.id;
      });
      const store = sqliteStore(root);
      const ask = async (q, limit) => (await store.searchRecallEntries(q, {
        limit, tenantId: 'default', explicitScopeMode: 'exact', includeSuperseded: true, ownScope: undefined,
      })).map((e) => e.id);
      const rowsOf = (list) => list.map((id) => ({ id }));
      const runs = [];
      for (const limit of limits) {
        const words = await ask(wordQuery, limit);
        const cjk = await ask(cjkQuery, limit);
        const both = await ask(query, limit);
        const expected = interleaveRows(rowsOf(words), rowsOf(cjk), limit).map((row) => row.id);
        runs.push({ limit, words, cjk, both, expected });
      }
      await store.close();
      console.log(JSON.stringify({ shared: ids[0], runs }));
    `;
    // The first text holds both terms, so it lands in both lists and must come out once.
    const texts = ['cache 数据库 shared row', 'cache note one', 'cache note two', '数据库 note one', '数据库 note two'];
    const { shared, runs } = runModuleScript<{
      shared: string;
      runs: Array<{ limit: number; words: string[]; cjk: string[]; both: string[]; expected: string[] }>;
    }>(
      script,
      root,
      JSON.stringify({ texts, query: 'cache 数据库', wordQuery: 'cache', cjkQuery: '数据库', limits: [2, 4, 6] }),
    );
    for (const { words, both, expected } of runs) {
      expect(both).toEqual(expected);
      expect(both[0]).toBe(words[0]);
    }
    expect(runs.map((r) => r.both.length)).toEqual([2, 4, 5]);
    // At limit 6 every row of both lists is visited, so the shared row is reached twice and kept once.
    const all = runs[2]!;
    expect(all.words).toContain(shared);
    expect(all.cjk).toContain(shared);
    expect(new Set(all.both).size).toBe(5);
  });
});

describe('store-kit pure helpers', () => {
  let out: KitAnswers;
  const rows = (...ids: string[]): Array<{ id: string }> => ids.map((id) => ({ id }));
  // A drifted stamp has no zone, so Date reads it as local time: the expected value is derived from Date, not written out.
  const drifted = '2026-03-05 10:00:00';
  const iso = '2026-03-05T08:00:00.000Z';

  beforeAll(() => {
    out = callKit({
      sortableIso: ['sortableStamp', iso],
      sortableDrifted: ['sortableStamp', drifted],
      sortableUnreadable: ['sortableStamp', 'not a date'],
      splitIndexed: ['splitLikeTerms', ['ab', 'abc', '数据', '数据库', '𠀀𠀀'], true],
      splitUnindexed: ['splitLikeTerms', ['ab', 'abc', '数据库'], false],
      interleaveEmptyB: ['interleaveRows', rows('a', 'a', 'b'), [], 5],
      interleaveEmptyA: ['interleaveRows', [], rows('c', 'c', 'd', 'e'), 2],
      interleaveRepeat: ['interleaveRows', rows('a', 'b', 'c'), rows('b', 'd'), 3],
      interleaveMidPair: ['interleaveRows', rows('a', 'c'), rows('b', 'd'), 3],
      interleaveLongTail: ['interleaveRows', rows('a'), rows('b', 'c', 'd'), 10],
      interleaveLastRowFull: ['interleaveRows', [{ id: 'a', n: 1 }], [{ id: 'a', n: 2 }], 1],
      interleaveLimitZero: ['interleaveRows', rows('a'), rows('b'), 0],
      interleaveLimitNegative: ['interleaveRows', rows('a', 'c'), rows('b'), -1],
      interleaveLimitFraction: ['interleaveRows', rows('a', 'c'), rows('b', 'd'), 2.5],
      interleaveRepeatInLaterPairAtLimit2: [
        'interleaveRows',
        [{ id: 'x', n: 1 }, { id: 'y' }],
        [{ id: 'z' }, { id: 'x', n: 2 }],
        2,
      ],
      interleaveRepeatInLaterPairAtLimit3: [
        'interleaveRows',
        [{ id: 'x', n: 1 }, { id: 'y' }],
        [{ id: 'z' }, { id: 'x', n: 2 }],
        3,
      ],
      interleaveLastRow: [
        'interleaveRows',
        [{ id: 'a', n: 1 }],
        [
          { id: 'a', n: 2 },
          { id: 'b', n: 3 },
        ],
        3,
      ],
      likeRows: ['LIKE_WINDOW_ROWS'],
      likeTerms: ['LIKE_WINDOW_TERMS'],
      schemaFitRows: ['SCHEMA_FIT_WINDOW_ROWS'],
      recallOnly: ['RECALL_ONLY_TAGS'],
    });
  });

  it('sortableStamp keeps an ISO stamp, reads a drifted one as Date does, and sorts an unreadable one first', () => {
    expect(out['sortableIso']).toBe(iso);
    expect(out['sortableDrifted']).toBe(new Date(Date.parse(drifted)).toISOString());
    expect(out['sortableUnreadable']).toBe('');
  });

  it('splitLikeTerms indexes a term of 3 or more code points, not 3 UTF-16 units', () => {
    // The Han Extension B pair is 2 code points and 4 UTF-16 units, which a .length split would index.
    expect(out['splitIndexed']).toEqual({ indexed: ['abc', '数据库'], windowed: ['ab', '数据', '𠀀𠀀'] });
    expect(out['splitUnindexed']).toEqual({ indexed: [], windowed: ['ab', 'abc', '数据库'] });
  });

  it('interleaveRows takes the lists in turn, keeps each id once and stops at the limit, even inside a pair', () => {
    expect(out['interleaveRepeat']).toEqual(rows('a', 'b', 'd'));
    expect(out['interleaveMidPair']).toEqual(rows('a', 'b', 'c'));
    expect(out['interleaveLongTail']).toEqual(rows('a', 'b', 'c', 'd'));
  });

  it('interleaveRows keeps a repeated id at its first place with the row object seen last', () => {
    expect(out['interleaveLastRow']).toEqual([
      { id: 'a', n: 2 },
      { id: 'b', n: 3 },
    ]);
    expect(out['interleaveLastRowFull']).toEqual([{ id: 'a', n: 2 }]);
    expect(out['interleaveRepeatInLaterPairAtLimit2']).toEqual([{ id: 'x', n: 2 }, { id: 'z' }]);
    expect(out['interleaveRepeatInLaterPairAtLimit3']).toEqual([{ id: 'x', n: 2 }, { id: 'z' }, { id: 'y' }]);
  });

  it('interleaveRows returns no row at a limit of 0 or below, and rounds a fraction up', () => {
    expect(out['interleaveLimitZero']).toEqual([]);
    expect(out['interleaveLimitNegative']).toEqual([]);
    expect(out['interleaveLimitFraction']).toEqual(rows('a', 'b', 'c'));
  });

  it('interleaveRows keeps the limit and the one-id rule when one list is empty', () => {
    expect(out['interleaveEmptyB']).toEqual(rows('a', 'b'));
    expect(out['interleaveEmptyA']).toEqual(rows('c', 'd'));
  });

  it('publishes the window sizes and the recall-only tags', () => {
    expect([out['likeRows'], out['likeTerms'], out['schemaFitRows']]).toEqual([2000, 64, 2000]);
    expect(out['recallOnly']).toEqual(['captured-note', 'user-message']);
  });

  it('splits a term list into word and CJK terms and takes the trigrams of each CJK run', () => {
    const script = `
      import { tokenize } from 'hippo-memory';
      import { cjkIndexTerms, partitionCjkTerms } from 'hippo-memory/store-kit';
      const answers = JSON.parse(process.argv[1]).map((text) => {
        const terms = tokenize(text);
        return { terms, parts: partitionCjkTerms(terms), trigrams: cjkIndexTerms(text) };
      });
      console.log(JSON.stringify(answers));
    `;
    expect(runModuleScript(script, JSON.stringify(['cache 数据库', '数据库系统']))).toEqual([
      {
        terms: ['cache', '数据', '据库'],
        parts: { words: ['cache'], cjk: ['数据', '据库'] },
        trigrams: ['数据库'],
      },
      {
        terms: ['数据', '据库', '库系', '系统'],
        parts: { words: [], cjk: ['数据', '据库', '库系', '系统'] },
        trigrams: ['数据库', '据库系', '库系统'],
      },
    ]);
  });
});
