import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeEntryDbOnly } from '../../src/store/sqlite/entries/entry-writes.js';
import { listRecallEntries } from '../../src/store/sqlite/recall/search-rows.js';
import { loadSearchEntries, writeEntry, writeEntriesTogether } from '../_helpers/root-forms.js';
import { createRequire } from 'node:module';
import { closeHippoDb, openHippoDb, setMeta } from '../../src/db/index.js';
import { LIKE_WINDOW_TERMS } from '../../src/store/rules/windows.js';
import { tokenize } from '../../src/base/util/tokenize.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { recordStatements } from '../_helpers/count-statements.js';
import { removeDir } from '../_helpers/remove-dir.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

// SAFETY: node:sqlite has no bundled types; `all` takes SQL params and returns the rows.
const { StatementSync } = createRequire(import.meta.url)('node:sqlite') as {
  StatementSync: { prototype: { all(...params: unknown[]): unknown[] } };
};

function makeRaw(text: string): MemoryEntry {
  return createMemory(text, {
    layer: Layer.Buffer,
    confidence: 'observed',
    kind: 'raw',
    tenantId: 'default',
  });
}

describe('loadSearchEntries paths', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('f1');
  });
  afterEach(() => removeDir(root));

  it('FTS path: a match in a shorter row ranks first, and no row carries a score', () => {
    writeEntry(root, makeRaw('alpha beta'));
    writeEntry(root, makeRaw('alpha ant beta gamma delta'));
    writeEntry(root, makeRaw('zeta eta theta'));
    const results = loadSearchEntries(root, 'alpha beta', 200, 'default');
    expect(results.map((e) => e.content)).toEqual(['alpha beta', 'alpha ant beta gamma delta']);
    expect(results.filter((e) => 'bm25Score' in e)).toEqual([]);
  });

  it('FTS path: a two-term match ranks before a one-term match', () => {
    writeEntry(root, makeRaw('alpha beta'));
    writeEntry(root, makeRaw('alpha alone'));
    const results = loadSearchEntries(root, 'alpha beta', 200, 'default');
    expect(results.map((e) => e.content)).toEqual(['alpha beta', 'alpha alone']);
  });

  it('No-terms path: an empty query returns every row', () => {
    writeEntry(root, makeRaw('any content'));
    const results = loadSearchEntries(root, '', 200, 'default');
    expect(results.map((e) => e.content)).toEqual(['any content']);
  });

  it('No-terms path: honours the LIMIT parameter', async () => {
    for (let i = 0; i < 50; i++) writeEntry(root, makeRaw(`row ${i}`));

    const results = loadSearchEntries(root, '', 10, 'default');
    expect(results.length).toBe(10);
  });

  it('No-terms path: returns rows ordered by created ASC then id ASC, with stamped created surviving writeEntry', async () => {
    const probe = makeRaw('roundtrip probe');
    probe.created = '2026-05-06T00:00:00.000Z';
    probe.validFrom = probe.created;
    writeEntry(root, probe);
    const reread = loadSearchEntries(root, '', 1, 'default');
    expect(reread.length).toBe(1);
    expect(reread[0]!.created).toBe('2026-05-06T00:00:00.000Z');

    const created: string[] = [];
    for (let i = 0; i < 50; i++) {
      const e = makeRaw(`row-${i.toString().padStart(2, '0')}`);
      e.created = new Date(Date.UTC(2026, 4, 6, 1, 0, i)).toISOString();
      created.push(e.created);
      writeEntry(root, e);
    }

    const results = loadSearchEntries(root, '', 10, 'default');
    expect(results.length).toBe(10);
    const expectedOrder = ['2026-05-06T00:00:00.000Z', ...created.slice(0, 9)];
    const got = results.map((e) => e.created);
    expect(got).toEqual(expectedOrder);
  });

  it('LIKE fallback path: a part-word query reaches LIKE; expected row anchored', () => {
    // FTS5 matches whole tokens, so a part-word is the only route to LIKE that leaves the FTS index untouched.
    writeEntry(root, makeRaw('alphabet soup contents'));
    const results = loadSearchEntries(root, 'alphab', 200, 'default');
    expect(results).toHaveLength(1);
    expect(results.some((e) => e.content === 'alphabet soup contents')).toBe(true);
  });

  it('FTS path: a word only the lead-in holds finds its row', () => {
    const led = { ...makeRaw('Three times a week'), leadIn: 'user: How often do you run the zephyrline' };
    writeEntry(root, led);
    writeEntry(root, makeRaw('Plain row with no lead-in'));
    expect(loadSearchEntries(root, 'zephyrline', 200, 'default').map((e) => e.id)).toEqual([led.id]);
  });

  it('the environment cannot force the LIKE route: with the old variable set, a term query still comes back through FTS', () => {
    writeEntry(root, makeRaw('alphabet soup contents'));
    writeEntry(root, makeRaw('alphabetical order'));
    vi.stubEnv('HIPPO_FORCE_LIKE_PATH', '1');
    // LIKE would also match the substring in 'alphabetical'; FTS5 matches the whole token only.
    const results = loadSearchEntries(root, 'alphabet', 200, 'default');
    expect(results.map((e) => e.content)).toEqual(['alphabet soup contents']);
  });

  it('LIKE fallback path: a query matching nothing tests the same number of rows however large the store', () => {
    const db = openHippoDb(root);
    try {
      let lowered = 0;
      // SAFETY: node:sqlite's DatabaseSync has `function` at runtime; DatabaseSyncLike omits it because src registers none.
      (db as typeof db & { function(name: string, fn: (text: string) => string): void }).function('lower', (text) => {
        lowered++;
        return text.toLowerCase();
      });
      const rowsTested = [3000, 6000].map((size, step) => {
        db.exec('BEGIN');
        for (let i = step * 3000; i < size; i++) writeEntryDbOnly(db, makeRaw(`deploy note ${i}`));
        db.exec('COMMIT');
        const tested = (query: string): number => {
          lowered = 0;
          expect(listRecallEntries(db, query, { limit: 200, tenantId: 'default' })).toHaveLength(200);
          return lowered / 2;
        };
        expect(tested('zzzznonexistenttokenxxxxxx')).toBe(0);
        return tested('zq');
      });
      expect(rowsTested[0]).toBe(2000);
      expect(rowsTested[1]).toBe(rowsTested[0]);
    } finally {
      closeHippoDb(db);
    }
  }, 30_000);

  it('substring path: a part-word finds a row older than the 2,000 newest, through the trigram index', () => {
    const db = openHippoDb(root);
    try {
      db.exec('BEGIN');
      writeEntryDbOnly(db, makeRaw('the quillwortledger entry'));
      for (let i = 0; i < 2500; i++) writeEntryDbOnly(db, makeRaw(`deploy note ${i}`));
      db.exec('COMMIT');
      const { result, statements } = recordStatements(() =>
        listRecallEntries(db, 'wortledg', { limit: 200, tenantId: 'default' }),
      );
      expect(result.map((e) => e.content)).toEqual(['the quillwortledger entry']);

      const sql = statements.find((text) => text.includes('memories_trigram MATCH'));
      expect(sql).toBeDefined();
      // SAFETY: EXPLAIN QUERY PLAN answers one row per step, its text in `detail`.
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail);
      expect(plan).toContainEqual(expect.stringMatching(/^SCAN t VIRTUAL TABLE INDEX \d+:/));
      expect(plan).toContainEqual(expect.stringMatching(/^SEARCH m USING INTEGER PRIMARY KEY \(rowid=\?\)/));
    } finally {
      closeHippoDb(db);
    }
  }, 30_000);

  it('CJK path: a Chinese query returns only the rows holding its words', () => {
    writeEntry(root, makeRaw('数据库连接池的大小必须设置为二十'));
    writeEntry(root, makeRaw('部署前必须先运行迁移脚本'));
    writeEntry(root, makeRaw('alpha beta'));
    const results = loadSearchEntries(root, '数据库连接池', 200, 'default');
    expect(results.map((e) => e.content)).toEqual(['数据库连接池的大小必须设置为二十']);
  });

  it('CJK path: a row holding a Korean word as a whole FTS5 token does not hide the row holding it with a particle', () => {
    writeEntry(root, makeRaw('크기 확인'));
    writeEntry(root, makeRaw('연결 풀 크기는 이십'));
    writeEntry(root, makeRaw('alpha beta'));
    const results = loadSearchEntries(root, '크기', 200, 'default');
    expect(results.map((e) => e.content).sort()).toEqual(['연결 풀 크기는 이십', '크기 확인']);
  });

  it('mixed query: a Chinese-only row joins the FTS rows of the English word', () => {
    writeEntry(root, makeRaw('postgres tuning notes'));
    writeEntry(root, makeRaw('连接池在部署后泄漏'));
    writeEntry(root, makeRaw('alpha beta'));
    const results = loadSearchEntries(root, 'postgres 连接池', 200, 'default');
    expect(results.map((e) => e.content).sort()).toEqual(['postgres tuning notes', '连接池在部署后泄漏'].sort());
  });

  it('a long CJK query stays under the SQL expression depth limit and still finds its rows', () => {
    const han = Array.from({ length: 1000 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('');
    const cjkRow = `${han.slice(0, 6)} 的说明`;
    writeEntry(root, makeRaw('postgres tuning notes'));
    writeEntry(root, makeRaw(cjkRow));
    writeEntry(root, makeRaw('alpha beta'));
    const results = loadSearchEntries(root, `postgres ${han}`, 200, 'default');
    expect(results.map((e) => e.content).sort()).toEqual([cjkRow, 'postgres tuning notes'].sort());
  });

  it('a query of 2,000 CJK bigrams binds at most LIKE_WINDOW_TERMS patterns for the window LIKE', () => {
    writeEntry(root, makeRaw('alpha beta'));
    const han = Array.from({ length: 2001 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('');
    const all = vi.spyOn(StatementSync.prototype, 'all');
    try {
      loadSearchEntries(root, han, 200, 'default');
      const likes = all.mock.calls
        .flat()
        .map(String)
        .filter((v) => v.startsWith('["%'));
      expect(likes).toHaveLength(1);
      expect(JSON.parse(likes[0] ?? '')).toHaveLength(LIKE_WINDOW_TERMS);
    } finally {
      all.mockRestore();
    }
  });

  it.each([
    ['FTS5 on, a 2-letter term', '1', 'zq'],
    ['FTS5 off, every term', '0', 'zqxvli'],
  ])('window LIKE path, %s: a part of a word only the lead-in holds finds its row', (_name, fts, query) => {
    const db = openHippoDb(root);
    try {
      setMeta(db, 'fts5_available', fts);
      const led = { ...makeRaw('Three times a week'), leadIn: 'user: How often do you run the zqxvline' };
      writeEntryDbOnly(db, led);
      writeEntryDbOnly(db, makeRaw('Plain row with no lead-in'));
      const found = listRecallEntries(db, query, { limit: 200, tenantId: 'default' });
      expect(found.map((e) => e.id)).toEqual([led.id]);
    } finally {
      closeHippoDb(db);
    }
  });

  it.each([
    ['FTS5 on, a 2-letter term', '1', '_z', 'a_zeta marker', 'bzeta marker'],
    ['FTS5 off, every term', '0', 'a_zeta', 'a_zeta marker', 'a-zeta marker'],
  ])('window LIKE path, %s: `_` in a term matches only itself', (_name, fts, query, hit, miss) => {
    expect(tokenize('a%z 50%')).toEqual(['50']);
    const db = openHippoDb(root);
    try {
      setMeta(db, 'fts5_available', fts);
      writeEntryDbOnly(db, makeRaw(hit));
      writeEntryDbOnly(db, makeRaw(miss));
      const found = listRecallEntries(db, query, { limit: 200, tenantId: 'default' });
      expect(found.map((e) => e.content)).toEqual([hit]);
    } finally {
      closeHippoDb(db);
    }
  });

  it('CJK substring path: a Chinese row older than the 2,000 newest is found through the trigram index', () => {
    const db = openHippoDb(root);
    try {
      db.exec('BEGIN');
      writeEntryDbOnly(db, makeRaw('数据库连接池的大小必须设置为二十'));
      for (let i = 0; i < 2500; i++) writeEntryDbOnly(db, makeRaw(`deploy note ${i}`));
      db.exec('COMMIT');
      const found = listRecallEntries(db, '数据库连接池', { limit: 200, tenantId: 'default' });
      expect(found.map((e) => e.content)).toEqual(['数据库连接池的大小必须设置为二十']);
    } finally {
      closeHippoDb(db);
    }
  }, 30_000);

  it('Full-store fallback path: terms that match nothing in FTS5 or LIKE return every row', () => {
    writeEntry(root, makeRaw('one row'));
    writeEntry(root, makeRaw('another row'));
    const results = loadSearchEntries(root, 'zzzznonexistenttokenxxxxxx qqqqqqq', 200, 'default');
    expect(results.map((e) => e.content).sort()).toEqual(['another row', 'one row']);
  });

  it('Full-store fallback path: honours LIMIT (regression: it was once uncapped)', () => {
    writeEntriesTogether(
      root,
      Array.from({ length: 30 }, (_, i) => makeRaw(`content ${i}`)),
    );
    const results = loadSearchEntries(root, 'zzzznonexistenttokenxxxxxx qqqqqqq', 10, 'default');
    expect(results.length).toBe(10);
  });
});
