// Z1b latency fix: rarest-term FTS pre-select (docs/plans/2026-09-26-z1b-tool-recall.md).
// Real SQLite store in a tmp dir, no mocks.
import { describe, it, expect, beforeEach } from 'vitest';
import { listRecallEntries, pickRarestFtsQuery } from '../../src/store/sqlite/recall/search-rows.js';
import { listRecallEntriesInFolder } from '../../src/store/sqlite/fixtures.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { openHippoDb, closeHippoDb, setMeta } from '../../src/db/index.js';
import { makeStore } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { ALL_TENANTS } from '../../src/base/util/tenant.js';
import { recordStatements } from '../_helpers/count-statements.js';

let root: string;

beforeEach(() => {
  ({ root } = makeStore('rarest-fts'));
});

describe('pickRarestFtsQuery', () => {
  it('picks the rarest terms by real FTS doc count, dropping none that survive the cap', () => {
    for (let i = 0; i < 5; i++) {
      writeEntry(root, createMemory(`common word appears in many rows number ${i}`));
    }
    writeEntry(root, createMemory('needle is the one rare distinctive token here'));

    const db = openHippoDb(root);
    try {
      const terms = ['common', 'word', 'appears', 'many', 'rows', 'number', 'needle', 'rare', 'distinctive', 'token'];
      const query = pickRarestFtsQuery(db, terms, 3);
      const picked = query.split(' ');
      expect(picked).toHaveLength(3);
      expect(picked).toContain('needle');
      expect(picked).not.toContain('common');
    } finally {
      closeHippoDb(db);
    }
  });

  it('keeps snake_case terms the FTS tokenizer splits into parts', () => {
    writeEntry(root, createMemory('set journal_mode to wal and raise busy_timeout for sqlite'));
    const db = openHippoDb(root);
    try {
      const query = pickRarestFtsQuery(db, ['journal_mode', 'busy_timeout', 'never_seen'], 8);
      expect(query.split(' ').sort()).toEqual(['busy_timeout', 'journal_mode']);
      expect(listRecallEntries(db, query, { tenantId: ALL_TENANTS, limit: 10 })).toHaveLength(1);
    } finally {
      closeHippoDb(db);
    }
  });

  it('drops a term with zero FTS doc count (never in any row)', () => {
    writeEntry(root, createMemory('the postgres migration rollback plan'));
    const db = openHippoDb(root);
    try {
      const query = pickRarestFtsQuery(db, ['postgres', 'xyzneverindexed'], 8);
      expect(query.split(' ')).toEqual(['postgres']);
    } finally {
      closeHippoDb(db);
    }
  });

  it('falls back to the first 32 terms, in order, when FTS is unavailable', () => {
    const db = openHippoDb(root);
    try {
      setMeta(db, 'fts5_available', '0');
      const terms = Array.from({ length: 40 }, (_, i) => `t${i}`);
      expect(pickRarestFtsQuery(db, terms, 2)).toBe(terms.slice(0, 32).join(' '));
    } finally {
      closeHippoDb(db);
    }
  });

  it('without FTS, keeps 16 of the 32 slots for CJK terms after 40 words', () => {
    const db = openHippoDb(root);
    try {
      setMeta(db, 'fts5_available', '0');
      const words = Array.from({ length: 40 }, (_, i) => `t${i}`);
      const cjk = Array.from({ length: 20 }, (_, i) => String.fromCodePoint(0x4e00 + i).repeat(3));
      const picked = pickRarestFtsQuery(db, [...words, ...cjk], 8).split(' ');
      expect(picked).toHaveLength(32);
      expect(picked.filter((t) => cjk.includes(t))).toHaveLength(16);
      expect(picked).toContain(cjk.at(-1));
    } finally {
      closeHippoDb(db);
    }
  });

  it('ranks CJK trigrams by their trigram-index count in the same pick as words', () => {
    const english = 'kubernetes ingress certificate renewal pipeline staging cluster rollout canary';
    for (const n of [1, 2]) writeEntry(root, createMemory(`${english} runbook ${n}`));
    writeEntry(root, createMemory('数据库连接池的大小必须设置为二十'));
    const db = openHippoDb(root);
    try {
      const terms = [...english.split(' '), '连接池', '接池的', '池的大', '的大小', '从未见'];
      const picked = pickRarestFtsQuery(db, terms, 8).split(' ');
      expect(picked.slice(0, 4)).toEqual(['池的大', '接池的', '的大小', '连接池'].sort());
      expect(picked).toHaveLength(8);
      expect(picked).not.toContain('从未见');
    } finally {
      closeHippoDb(db);
    }
  });

  it('counts a CJK run shorter than a trigram by the trigrams it opens, and keeps one that counts 0 last', () => {
    writeEntry(root, createMemory('배포 전에 캐시를 비워야 한다'));
    const db = openHippoDb(root);
    try {
      expect(pickRarestFtsQuery(db, ['없음', '캐시'], 8)).toBe('캐시 없음');
    } finally {
      closeHippoDb(db);
    }
  });

  it('keeps a two-letter CJK term that only ends a row, which no trigram opens', () => {
    writeEntry(root, createMemory('生产数据库必须使用连接池'));
    const db = openHippoDb(root);
    try {
      expect(pickRarestFtsQuery(db, ['接池'], 8)).toBe('接池');
    } finally {
      closeHippoDb(db);
    }
  });

  it('asks the word vocabulary about words only, never about CJK terms', () => {
    writeEntry(root, createMemory('postgres 数据库连接池'));
    const db = openHippoDb(root);
    try {
      const { statements } = recordStatements(() => pickRarestFtsQuery(db, ['postgres', '数据库', '据库连'], 8));
      const wordReads = statements.filter((sql) => sql.includes('z1_rarest_vocab WHERE term IN'));
      expect(wordReads).toEqual(['SELECT term, doc FROM temp.z1_rarest_vocab WHERE term IN (?)']);
    } finally {
      closeHippoDb(db);
    }
  });
});

describe('listRecallEntries', () => {
  it('matches loadRecallSearchEntries for the same args (open/close wrapper is a pure split)', () => {
    writeEntry(root, createMemory('the postgres migration rollback plan for deploy'));
    writeEntry(root, createMemory('unrelated gardening tips for tomatoes'));

    const viaPublic = listRecallEntriesInFolder(root, 'postgres migration rollback', {
      limit: 10,
      tenantId: ALL_TENANTS,
      explicitScopeMode: 'exact',
      includeSuperseded: true,
    });

    const db = openHippoDb(root);
    let viaDb;
    try {
      viaDb = listRecallEntries(db, 'postgres migration rollback', {
        tenantId: ALL_TENANTS,
        limit: 10,
        includeSuperseded: true,
      });
    } finally {
      closeHippoDb(db);
    }

    expect(viaDb.map((e) => e.id)).toEqual(viaPublic.map((e) => e.id));
    expect(viaPublic.map((e) => e.content)).toEqual(['the postgres migration rollback plan for deploy']);
  });
});
