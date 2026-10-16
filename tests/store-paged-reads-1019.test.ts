// A mirror sync that spans several pages, and a recall trace written in one or many multi-row inserts.

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { serializeEntry } from '../src/core/markdown.js';
import { initStore } from '../src/store/open.js';
import { writeEntriesTogether } from '../src/store/entry-writes.js';
import { syncMirrorFiles } from '../src/store/mirrors.js';
import { writeRecallTrace } from '../src/store/recall-trace.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';

let home: string;
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function freshRoot(): string {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-paged-reads-'));
  const root = path.join(home, '.hippo');
  initStore(root);
  return root;
}

describe('syncMirrorFiles', () => {
  it('rewrites every mirror byte for byte when the rows span more than one page', () => {
    const root = freshRoot();
    writeEntriesTogether(root, Array.from({ length: 530 }, (_, i) => ({ ...createMemory(`paged mirror row number ${i}`), id: `mem_page_${i}` })));
    const entries = loadAllEntries(root).filter((e) => e.id.startsWith('mem_page_'));
    expect(entries).toHaveLength(530);
    const files = entries.map((e) => path.join(root, e.layer, `${e.id}.md`));
    for (const f of files) fs.rmSync(f);

    const db = openHippoDb(root);
    try {
      syncMirrorFiles(root, db);
    } finally {
      closeHippoDb(db);
    }

    for (const [i, f] of files.entries()) expect(fs.readFileSync(f, 'utf8')).toBe(serializeEntry(entries[i]!));
  });
});

describe('writeRecallTrace', () => {
  it('writes a trace with no results, and one whose results need several inserts, with ranks in order', () => {
    const root = freshRoot();
    const db = openHippoDb(root);
    try {
      const base = { tenantId: 'default', pipeline: 'api' as const, query: 'q' };
      const empty = writeRecallTrace(db, { ...base, results: [] });
      const many = writeRecallTrace(db, {
        ...base,
        results: Array.from({ length: 250 }, (_, i) => ({ memoryId: `m${i}`, score: i / 250 })),
      });
      const count = (id: number | null) =>
        // SAFETY: COUNT(*) AS n returns one row of that shape.
        (db.prepare('SELECT COUNT(*) AS n FROM recall_trace_results WHERE trace_id = ?').get(id) as { n: number }).n;
      expect(count(empty)).toBe(0);
      expect(count(many)).toBe(250);
      // SAFETY: the SELECT names the single memory_id column.
      const last = db.prepare('SELECT memory_id FROM recall_trace_results WHERE trace_id = ? AND result_rank = 250')
        .get(many) as { memory_id: string };
      expect(last.memory_id).toBe('m249');
    } finally {
      closeHippoDb(db);
    }
  });
});
