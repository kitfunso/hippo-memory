// Z1b latency fix: rarest-term FTS pre-select (docs/plans/2026-09-26-z1b-tool-recall.md).
// Real SQLite store in a tmp dir, no mocks.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  initStore,
  writeEntry,
  loadRecallSearchEntries,
  loadRecallSearchEntriesFromDb,
  pickRarestFtsQuery,
} from '../src/store.js';
import { createMemory } from '../src/memory.js';
import { openHippoDb, closeHippoDb, setMeta } from '../src/db.js';

let tmpRoot: string;
let root: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-rarest-fts-'));
  root = path.join(tmpRoot, '.hippo');
  fs.mkdirSync(root, { recursive: true });
  initStore(root);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
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

  it('falls back to the first maxTerms terms, in order, when FTS is unavailable', () => {
    const db = openHippoDb(root);
    try {
      setMeta(db, 'fts5_available', '0');
      const query = pickRarestFtsQuery(db, ['alpha', 'beta', 'gamma', 'delta'], 2);
      expect(query).toBe('alpha beta');
    } finally {
      closeHippoDb(db);
    }
  });
});

describe('loadRecallSearchEntriesFromDb', () => {
  it('matches loadRecallSearchEntries for the same args (open/close wrapper is a pure split)', () => {
    writeEntry(root, createMemory('the postgres migration rollback plan for deploy'));
    writeEntry(root, createMemory('unrelated gardening tips for tomatoes'));

    const viaPublic = loadRecallSearchEntries(root, 'postgres migration rollback', 10, undefined, undefined, 'exact', true);

    const db = openHippoDb(root);
    let viaDb;
    try {
      viaDb = loadRecallSearchEntriesFromDb(db, 'postgres migration rollback', 10, undefined, undefined, 'exact', true);
    } finally {
      closeHippoDb(db);
    }

    expect(viaDb.map((e) => e.id)).toEqual(viaPublic.map((e) => e.id));
    expect(viaPublic.length).toBeGreaterThan(0);
  });
});
