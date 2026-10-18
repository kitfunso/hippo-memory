// An audit store that will not open during sleep's rescue audit is a warn line with the error class, not a debug line nobody sees.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { consolidate } from '../../src/index.js';
import { calculateStrength, Layer, type MemoryEntry } from '../../src/core/memory.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntriesTogether } from '../_helpers/root-forms.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const NOW = new Date('2026-08-10T12:00:00.000Z');

/** Ancient with a one-day half-life, so decay condemns it and memory-value may rescue it. */
function condemned(content: string): MemoryEntry {
  const created = new Date(NOW.getTime() - 3650 * 86_400_000).toISOString();
  const entry: MemoryEntry = {
    ...createMemory(content, { layer: Layer.Semantic, tenantId: 'ta' }),
    created,
    lastRetrieved: created,
    validFrom: created,
    halfLifeDays: 1,
    retrievalCount: 0,
    pinned: false,
  };
  return { ...entry, strength: calculateStrength(entry, NOW) };
}

describe('sleep rescue audit', () => {
  it('warns with the error class when the audit store will not open, and still reports the unaudited rescues', async () => {
    const root = makeRoot('rescue-audit');
    roots.push(root);
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({ memoryValue: { enabled: true }, physics: { enabled: false }, dormant: { enabled: false } }),
    );
    writeEntriesTogether(
      root,
      [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((len) => condemned('w'.repeat(len))),
    );
    // The sleep-count write lands just before the rescue audit; stamping the store for a newer binary there makes the audit's open refuse.
    const db = openHippoDb(root);
    try {
      for (const event of ['INSERT', 'UPDATE']) {
        db.exec(`CREATE TRIGGER newer_binary_after_${event.toLowerCase()} AFTER ${event} ON meta WHEN NEW.key = 'sleep_count'
          BEGIN INSERT OR REPLACE INTO meta (key, value) VALUES ('min_compatible_binary', '999.0.0'); END`);
      }
    } finally {
      closeHippoDb(db);
    }
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = await consolidate(root, { now: NOW });

    const lines = stderr.mock.calls.map(([chunk]) => String(chunk));
    expect(
      lines.some(
        (l) =>
          l.includes('warn: mv_rescue audit unavailable: hippo-memory: this database requires') &&
          l.includes('errorClass=IncompatibleBinaryError') &&
          l.includes('stack='),
      ),
    ).toBe(true);
    expect(result.details).toContain(
      '  ⚠️ memory-value: mv_rescue audit unavailable this cycle (3 rescues not audited)',
    );
  });
});
