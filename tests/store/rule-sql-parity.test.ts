// The SQL twins in src/store/sqlite/rule-sql.ts equal their JS rules over a seeded spread: strength under a
// loss-aversion ratio (tests/core/memory.test.ts holds the default ratio) and the bare text of a stored content.
import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calculateStrength, type EmotionalValence, type MemoryEntry } from '../../src/base/memory/memory.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { bareText, SPACE_CODES } from '../../src/store/rules/copies.js';
import { bareTextSql, strengthSql } from '../../src/store/sqlite/rule-sql.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntriesTogether } from '../_helpers/root-forms.js';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const VALENCES: readonly EmotionalValence[] = ['neutral', 'positive', 'negative', 'critical'];

function spread(): MemoryEntry[] {
  const at = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
  const rows: MemoryEntry[] = [];
  for (const valence of VALENCES) {
    for (const [age, pinned, positive, negative] of [
      [0, false, 0, 0],
      [10, false, 3, 0],
      [60, false, 0, 4],
      [400, true, 0, 2],
      [30, false, 5, 5],
    ] as const) {
      rows.push({
        ...createMemory(`ratio ${valence} ${age} ${pinned} ${positive} ${negative}`),
        lastRetrieved: at(age),
        emotionalValence: valence,
        pinned,
        outcomePositive: positive,
        outcomeNegative: negative,
        halfLifeDays: 14,
      });
    }
  }
  return rows;
}

describe('strengthSql parity under a loss-aversion ratio', () => {
  it.each([1, 1.5, 3])('scores each stored row as calculateStrength does at ratio %s', (ratio) => {
    const entries = spread();
    const home = makeRoot(`strength-ratio-${ratio}`);
    try {
      writeEntriesTogether(home, entries);
      const db = openHippoDb(home);
      try {
        const rules = { lossAversionRatio: ratio };
        const strength = strengthSql(NOW, rules);
        // SAFETY: the SELECT names exactly the columns id and s.
        const rows = db.prepare(`SELECT id, ${strength.sql} AS s FROM memories`).all(...strength.params) as Array<{
          id: string;
          s: number;
        }>;
        expect(rows).toHaveLength(entries.length);
        for (const row of rows) {
          const entry = entries.find((e) => e.id === row.id);
          if (!entry) throw new Error(`unexpected row ${row.id}`);
          expect(Math.abs(row.s - calculateStrength(entry, NOW, rules)), row.id).toBeLessThan(1e-9);
        }
      } finally {
        closeHippoDb(db);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('bareTextSql parity', () => {
  it('removes the spaces bareText removes, from texts that hold every one of them and none', () => {
    const everySpace = String.fromCodePoint(...SPACE_CODES);
    const texts = [
      '',
      'plain',
      'two words',
      `a${everySpace}b`,
      ...SPACE_CODES.map((c) => `x${String.fromCodePoint(c)}y`),
    ];
    const home = makeRoot('bare-text-parity');
    try {
      const db = openHippoDb(home);
      try {
        const query = db.prepare(`SELECT ${bareTextSql('t')} AS b FROM (SELECT ? AS t)`);
        for (const text of texts) {
          // SAFETY: the SELECT names the single column b.
          expect((query.get(text) as { b: string }).b).toBe(bareText(text));
        }
      } finally {
        closeHippoDb(db);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
