// Past the cap, loadContextCandidates reads the v60 decay-key subset and must return the rows the full-tenant rank would.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../src/db/index.js';
import { DECAY_KEY_HALF_LIVES, DECAY_KEY_INDEX } from '../src/db/decay-key.js';
import { _resetAblationCacheForTests } from '../src/core/ablation.js';
import type { MemoryEntry } from '../src/core/memory.js';
import { contextRowsWhere, loadContextCandidates } from '../src/store/candidates.js';
import { writeEntryDbOnly } from '../src/store/entry-writes.js';
import { rewardFactorSql } from '../src/store/rule-sql.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { recordStatements } from './_helpers/count-statements.js';
import { makeRoot } from './_helpers/make-root.js';

const DAY = 86_400_000;
const BASE = Date.UTC(2026, 5, 1);
const HALF_LIVES = [0, 0.5, 1, 3, 7, 14, 30, 90, 365];
const BAD_DATES = ['', 'not-a-date', '2026-13-45T99:00:00Z'];
const SUBSET = /WITH top AS MATERIALIZED/;
const SCAN = /ORDER BY pinned DESC,\s+CASE WHEN/;
const NOWS = [-30, 0, 3, 30, 200, 2000].map((days) => new Date(BASE + days * DAY));
const CAPS = [1, 7, 40, 120];

let home: string;

// A fixed-seed generator, so a failing case replays.
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

function seedRows(count: number): MemoryEntry[] {
  const next = rng(60);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
  return Array.from({ length: count }, (_, i) => {
    const roll = next();
    const age = roll < 0.05 ? -next() * 30 : next() * (roll < 0.5 ? 20 : 400);
    return {
      ...createMemory(`decay row ${i}`, { tenantId: i % 40 === 39 ? 'other' : 'default' }),
      id: `m${String(i).padStart(4, '0')}`,
      created: new Date(BASE - (count - i) * 60_000).toISOString(),
      last_retrieved: roll > 0.97 ? pick(BAD_DATES) : new Date(BASE - age * DAY).toISOString(),
      half_life_days: pick(HALF_LIVES),
      pinned: next() < 0.05,
      outcome_positive: next() < 0.4 ? Math.floor(next() * 9) : 0,
      outcome_negative: next() < 0.3 ? Math.floor(next() * 9) : 0,
      superseded_by: i % 50 === 49 ? 'm0000' : null,
    };
  });
}

function withDb<T>(fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(home);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

// The full-tenant rank as it was before v60, frozen here so a change to the live rank cannot move the expectation.
function scanIds(cap: number, now: Date, tenant = 'default'): string[] {
  const { where, params } = contextRowsWhere(tenant, {});
  const sql = `SELECT id FROM memories WHERE id IN (SELECT id FROM memories WHERE ${where.join(' AND ')}
    ORDER BY pinned DESC, CASE WHEN half_life_days > 0 THEN (julianday(?) - julianday(last_retrieved))
    / (half_life_days * ${rewardFactorSql()}) END ASC NULLS LAST, id ASC LIMIT ?) ORDER BY created ASC, id ASC`;
  // SAFETY: one TEXT `id` column.
  return withDb((db) => (db.prepare(sql).all(...params, now.toISOString(), cap) as Array<{ id: string }>).map((r) => r.id));
}

// The caps at which a key without the reward factor first drops a row it should keep: the pinned rows plus the rows that
// are within the key's half-lives both with and without the factor.
function plainKeyCaps(now: Date): number[] {
  const { where, params } = contextRowsWhere('default', {});
  const plain = '(julianday(?) - julianday(last_retrieved)) / half_life_days';
  const sql = `SELECT COUNT(*) AS n FROM memories WHERE ${where.join(' AND ')} AND (pinned > 0 OR (half_life_days > 0
    AND ${plain} <= ? AND ${plain} / ${rewardFactorSql()} <= ?))`;
  const iso = now.toISOString();
  // SAFETY: one INTEGER `n` column.
  const n = withDb((db) => (db.prepare(sql).get(...params, iso, DECAY_KEY_HALF_LIVES, iso, DECAY_KEY_HALF_LIVES) as { n: number }).n);
  return [n - 1, n].filter((cap) => cap >= 1);
}

function readOnce(cap: number, now: Date, tenant = 'default') {
  const { result, statements } = recordStatements(() => loadContextCandidates(home, tenant, { cap, now }));
  return {
    ids: result.map((e) => e.id),
    subset: statements.some((s) => SUBSET.test(s)),
    scan: statements.some((s) => SCAN.test(s)),
  };
}

beforeEach(() => {
  home = makeRoot('context-decay-index');
  _resetAblationCacheForTests();
  withDb((db) => {
    db.exec('BEGIN');
    for (const e of seedRows(600)) writeEntryDbOnly(db, e);
    db.exec('COMMIT');
  });
});

afterEach(() => {
  delete process.env.HIPPO_ABLATE_OUTCOME_SLOW;
  _resetAblationCacheForTests();
  rmSync(home, { recursive: true, force: true });
});

// Ten-day half-life rows, aged in half-lives: a boosted row the unscaled key would leave out must still outrank a plain one.
function rfRow(id: string, halfLivesOld: number, outcomePositive = 0): MemoryEntry {
  const lastRetrieved = new Date(BASE - halfLivesOld * 10 * DAY).toISOString();
  return {
    ...createMemory(`rf row ${id}`, { tenantId: 'rf' }),
    id,
    created: lastRetrieved,
    last_retrieved: lastRetrieved,
    half_life_days: 10,
    outcome_positive: outcomePositive,
  };
}

describe('loadContextCandidates past the cap', () => {
  it('returns the full-tenant rank rows in the same order, whichever path answers', () => {
    const paths = new Set<string>();
    for (const now of NOWS) {
      for (const cap of [...CAPS, ...plainKeyCaps(now)]) {
        const got = readOnce(cap, now);
        expect(got.ids, `cap ${cap} now ${now.toISOString()}`).toEqual(scanIds(cap, now));
        paths.add(got.subset && !got.scan ? 'subset' : 'scan');
      }
    }
    // Both arms must run, or the equality above proves nothing about the subset.
    expect([...paths].sort()).toEqual(['scan', 'subset']);
  });

  it('keeps a row whose outcomes slow its decay past the key plain rows would be cut at', () => {
    const plain = [3, 4, 5].map((n) => rfRow(`a${n}`, DECAY_KEY_HALF_LIVES - 0.1));
    // Eight positive outcomes scale the half-life by 1.44, so a row 1.25 key-lengths old reads 0.87 and beats the plain rows.
    const boosted = rfRow('b1', DECAY_KEY_HALF_LIVES * 1.25, 8);
    const dead = [1, 2, 3, 4].map((n) => rfRow(`d${n}`, 40));
    withDb((db) => {
      for (const e of [...plain, boosted, ...dead]) writeEntryDbOnly(db, e);
    });
    const now = new Date(BASE);
    const got = readOnce(3, now, 'rf');
    expect(got.ids).toEqual(['b1', 'a3', 'a4']);
    expect(got.ids).toEqual(scanIds(3, now, 'rf'));
    expect(got.subset && !got.scan).toBe(true);
  });

  it('falls to the scan when the subset is short', () => {
    const farFuture = new Date(BASE + 2000 * DAY);
    const got = readOnce(40, farFuture);
    expect(got.scan).toBe(true);
    expect(got.ids).toEqual(scanIds(40, farFuture));
  });

  it('ranks by the scan with the outcome-slow ablation on, and still matches it', () => {
    process.env.HIPPO_ABLATE_OUTCOME_SLOW = '1';
    _resetAblationCacheForTests();
    for (const now of NOWS) {
      for (const cap of CAPS) {
        const got = readOnce(cap, now);
        expect(got.subset).toBe(false);
        expect(got.ids, `cap ${cap} now ${now.toISOString()}`).toEqual(scanIds(cap, now));
      }
    }
  });

  it('reads the subset through the v60 index with no full scan of memories', () => {
    const { statements } = recordStatements(() => loadContextCandidates(home, 'default', { cap: 40, now: new Date(BASE) }));
    const sql = statements.find((s) => SUBSET.test(s));
    expect(sql).toBeDefined();
    const marks = (sql ?? '').match(/\?/g)?.length ?? 0;
    const plan = withDb((db) =>
      // SAFETY: EXPLAIN QUERY PLAN rows carry a TEXT `detail` column.
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array<string>(marks).fill('x')) as Array<{ detail: string }>)
        .map((r) => r.detail),
    );
    expect(plan.filter((line) => line.includes(`USING INDEX ${DECAY_KEY_INDEX} (tenant_id=? AND pinned=?`))).toHaveLength(2);
    expect(plan.some((line) => line.includes('AND <expr>>?)'))).toBe(true);
    expect(plan.filter((line) => /SCAN memories/.test(line))).toEqual([]);
  });
});
