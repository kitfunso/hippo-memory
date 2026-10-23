// `hippo conflicts` prints, a page at a time, the bytes it printed from the whole list in one array, and no read
// hands back more than one page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { conflictList, type ConflictPage } from '../../src/api/index.js';
import { conflictToWire } from '../../src/base/memory/conflict-wire.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import type { KeysetPosition } from '../../src/base/util/keyset.js';
import type { CliFlags } from '../../src/surface/cli/flag-values.js';
import { handleConflicts } from '../../src/surface/cli/curate.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { countMatching, peakRowsRead, recordStatementsAsync } from '../_helpers/count-statements.js';
import { makeRoot } from '../_helpers/make-root.js';
import { replaceDetectedConflicts, writeEntriesTogether } from '../_helpers/root-forms.js';

const LIST_READ = /ORDER BY mc\.updated_at DESC, mc\.id DESC LIMIT \?$/;
let root: string;

beforeEach(() => {
  root = makeRoot('conflicts-list-pages', { config: { embeddings: { enabled: false } } });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

/** `n` open conflicts in two tenants, all detected at one instant so page edges fall inside a tie. */
function seedConflicts(n: number): void {
  const rows = Array.from({ length: 2 * n }, (_, i) =>
    createMemory(`deploy rule number ${i}`, {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      tenantId: i % 4 < 2 ? 'default' : 'other',
    }),
  );
  writeEntriesTogether(root, rows);
  const pairs = Array.from({ length: n }, (_, i) => ({
    memory_a_id: rows[2 * i]!.id,
    memory_b_id: rows[2 * i + 1]!.id,
    reason: `contradiction ${i}`,
    score: 0.5 + i / (4 * n),
  }));
  replaceDetectedConflicts(root, pairs, '2026-10-17T00:00:00.000Z');
}

/** The whole list as the verb read it before: every page gathered into one array. */
async function wholeList(): Promise<ConflictPage['conflicts']> {
  const all: ConflictPage['conflicts'] = [];
  let after: KeysetPosition | undefined;
  do {
    const page = await conflictList(apiCtx(root), 'open', { everyTenant: true }, { limit: 1000, after });
    all.push(...page.conflicts);
    after = page.next ?? undefined;
  } while (after);
  return all;
}

function textOf(conflicts: ConflictPage['conflicts']): string[] {
  if (conflicts.length === 0) return ['No memory conflicts found.'];
  return [
    `Found ${conflicts.length} memory conflict${conflicts.length === 1 ? '' : 's'}\n`,
    ...conflicts.flatMap((c) => [
      `--- conflict_${c.id} score=${c.score.toFixed(3)} status=${c.status}`,
      `    ${c.memoryAId} <-> ${c.memoryBId}`,
      `    reason: ${c.reason}`,
      '',
    ]),
  ];
}

async function printed(flags: CliFlags) {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => {
    lines.push(line);
  });
  const log = await recordStatementsAsync(() =>
    handleConflicts({ hippoRoot: root, tenantId: 'default', args: [], flags }),
  );
  vi.restoreAllMocks();
  return { lines, reads: countMatching(log.statements, LIST_READ), peak: peakRowsRead(log.reads, LIST_READ) };
}

describe('hippo conflicts pages', () => {
  it.each([
    [0, 1, 1],
    [1, 1, 1],
    [3, 1, 1],
    [1002, 3, 2],
  ])(
    'prints %i conflicts as the whole list did, in %i reads as text and %i as JSON',
    async (n, textReads, jsonReads) => {
      seedConflicts(n);
      const whole = await wholeList();
      expect(whole).toHaveLength(n);

      const text = await printed({});
      expect(text.lines).toEqual(textOf(whole));
      expect(text.reads).toBe(textReads);
      expect(text.peak).toBeLessThanOrEqual(1001);

      const json = await printed({ json: true });
      expect(json.lines.join('\n')).toBe(JSON.stringify({ conflicts: whole.map(conflictToWire) }, null, 2));
      expect(json.reads).toBe(jsonReads);
      expect(json.peak).toBeLessThanOrEqual(1001);
    },
    120_000,
  );
});
