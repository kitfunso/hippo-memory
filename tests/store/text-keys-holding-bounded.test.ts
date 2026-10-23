// The sharing and agent-import copy reads: one statement per chunk of texts, only copies back, and the same copies a
// whole scan finds, with the full-text index in sync and out of sync.
import { beforeEach, describe, expect, it } from 'vitest';
import type { MemoryEntry } from '../../src/base/memory/memory.js';
import { AGENT_MEMORY_SOURCE_PREFIX } from '../../src/base/memory/agent-memory-tools.js';
import { chunked } from '../../src/base/util/chunked.js';
import { duplicateKey, heldTextKeys, mergedText } from '../../src/base/util/same-text.js';
import { ALL_TENANTS } from '../../src/base/util/tenant.js';
import { closeHippoDb, openHippoDb, setFtsInSync, type DatabaseSyncLike } from '../../src/db/index.js';
import { selectRowsHoldingOutsideSourcePrefix, selectTextKeysHolding } from '../../src/store/sqlite/copy-rows.js';
import { countMatching, peakRowsRead, recordStatements } from '../_helpers/count-statements.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeStore } from '../_helpers/make-root.js';
import { writeEntriesTogether } from '../_helpers/root-forms.js';

function withDb<T>(root: string, fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

const row = (content: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
  ...createMemory(content, { tenantId: 'default' }),
  ...extra,
});

const TEXT = 'pin the node version in the workflow file';
const OTHER = 'rotate the deploy key every ninety days';
const TEXTS = [TEXT, OTHER, 'cache the build output between runs'];

const COPIES = [
  row(`  ${TEXT.replaceAll(' ', '\n ')}  `),
  row(mergedText('Merged lessons', [OTHER, 'tag every release']), { source: 'consolidation' }),
];
const LEFT_OUT = [
  row(TEXT, { tenantId: 'acme' }),
  row(OTHER, { supersededBy: 'mem_newer' }),
  row(TEXT, { source: `${AGENT_MEMORY_SOURCE_PREFIX}claude-code` }),
];

// The answer with no bound: per text, the rows `admits` keeps that heldTextKeys says hold it.
function wholeScan(root: string, admits: (r: ScanRow) => boolean): string[][] {
  // SAFETY: the SELECT names exactly the ScanRow columns.
  const rows = withDb(root, (db) => db.prepare('SELECT * FROM memories').all() as ScanRow[]);
  return TEXTS.map((text) =>
    rows
      .filter((r) => admits(r) && heldTextKeys(r).includes(duplicateKey(text)))
      .map((r) => r.id)
      .sort(),
  );
}

interface ScanRow {
  id: string;
  tenant_id: string;
  content: string;
  source: string;
  superseded_by: string | null;
}

describe('copy reads by whole text', () => {
  let root: string;

  beforeEach(() => {
    root = makeStore('text-keys').root;
    const sharing = Array.from({ length: 50 }, (_, i) => row(`${TEXT} and step ${i} of ${OTHER}`));
    writeEntriesTogether(root, [...sharing, ...COPIES, ...LEFT_OUT]);
  });

  it.each([true, false])('textKeysHolding reads only the copies a whole scan finds, index in sync: %s', (inSync) => {
    withDb(root, (db) => setFtsInSync(db, inSync));
    const { result, reads } = recordStatements(() => withDb(root, (db) => selectTextKeysHolding(db, 'default', TEXTS)));
    const whole = wholeScan(root, (r) => r.tenant_id === 'default');
    const found = TEXTS.map((text) =>
      result
        .filter((k) => heldTextKeys(k).includes(duplicateKey(text)))
        .map((k) => k.id)
        .sort(),
    );
    expect(found).toEqual(whole);
    // The 2 copies plus the superseded and agent-memory rows, which this read keeps; none of the 50 sharing rows.
    expect(result.map((k) => k.id).sort()).toEqual(whole.flat().sort());
    expect(peakRowsRead(reads, 'json_each')).toBe(4);
  });

  it.each([true, false])(
    'rowsHoldingOutsideSourcePrefix answers per text as a whole scan, index in sync: %s',
    (inSync) => {
      withDb(root, (db) => setFtsInSync(db, inSync));
      const held = withDb(root, (db) =>
        selectRowsHoldingOutsideSourcePrefix(db, 'default', TEXTS, AGENT_MEMORY_SOURCE_PREFIX, null),
      );
      const live = (r: ScanRow) =>
        r.tenant_id === 'default' && r.superseded_by === null && !r.source.startsWith(AGENT_MEMORY_SOURCE_PREFIX);
      expect(held.map((rows) => rows.map((r) => r.id).sort())).toEqual(wholeScan(root, live));
    },
  );
});

describe('copy reads statements', () => {
  it.each([
    [10, true],
    [1200, true],
    [10, false],
    [1200, false],
  ])('run one statement per chunk at %i texts, index in sync: %s', (n, inSync) => {
    const root = makeStore('text-keys-chunks').root;
    writeEntriesTogether(root, [row('lesson 3 of the batch')]);
    withDb(root, (db) => setFtsInSync(db, inSync));
    const texts = Array.from({ length: n }, (_, i) => `lesson ${i} of the batch`);
    const keys = recordStatements(() => withDb(root, (db) => selectTextKeysHolding(db, ALL_TENANTS, texts)));
    const outside = recordStatements(() =>
      withDb(root, (db) =>
        selectRowsHoldingOutsideSourcePrefix(db, 'default', texts, AGENT_MEMORY_SOURCE_PREFIX, null),
      ),
    );
    expect(countMatching(keys.statements, 'json_each')).toBe(chunked(texts).length);
    expect(countMatching(outside.statements, 'json_each')).toBe(chunked(texts).length);
    expect(keys.result.map((k) => k.content)).toEqual(['lesson 3 of the batch']);
    expect(outside.result.map((rows) => rows.length)).toEqual(texts.map((_, i) => (i === 3 ? 1 : 0)));
  });
});
