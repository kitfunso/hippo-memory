// Z1b latency fix: rarest-term FTS pre-select (docs/plans/2026-09-26-z1b-tool-recall.md).
// Real SQLite store in a tmp dir, no mocks.
import { describe, it, expect, beforeEach } from 'vitest';
import { loadRecallEntries, pickRarestFtsQuery } from '../../src/store/sqlite/search-rows.js';
import { loadRecallSearchEntries } from '../../src/store/sqlite/fixtures.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { openHippoDb, closeHippoDb, setMeta } from '../../src/db/index.js';
import { makeStore } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { ALL_TENANTS } from '../../src/base/util/tenant.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

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
      expect(loadRecallEntries(db, query, { tenantId: ALL_TENANTS, limit: 10 })).toHaveLength(1);
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
});

describe('loadRecallEntries', () => {
  it('matches loadRecallSearchEntries for the same args (open/close wrapper is a pure split)', () => {
    writeEntry(root, createMemory('the postgres migration rollback plan for deploy'));
    writeEntry(root, createMemory('unrelated gardening tips for tomatoes'));

    const viaPublic = loadRecallSearchEntries(root, 'postgres migration rollback', {
      limit: 10,
      tenantId: ALL_TENANTS,
      explicitScopeMode: 'exact',
      includeSuperseded: true,
    });

    const db = openHippoDb(root);
    let viaDb;
    try {
      viaDb = loadRecallEntries(db, 'postgres migration rollback', {
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
