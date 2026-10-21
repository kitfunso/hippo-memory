// The agent memory sync's duplicate check against a real store: text another path holds, spacing aside or inside a
// sleep-merged row, is skipped with the index in sync or not, and the rows read stay flat as unrelated rows grow.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importForStore } from '../../src/domain/agent-memories/sync.js';
import type { ImportReport } from '../../src/domain/agent-memories/report.js';
import { loadConfig } from '../../src/base/config/config.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/memory.js';
import { setFtsInSync } from '../../src/db/index.js';
import { sqliteAgentImport } from '../../src/store/sqlite/agent-import.js';
import { writeEntryDbOnly } from '../../src/store/sqlite/entry-writes.js';
import { mergedText } from '../../src/base/util/same-text.js';
import { countMatching, recordStatements } from '../_helpers/count-statements.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import {
  closeWorld,
  liveTexts,
  note,
  openWorld,
  projectNotes,
  toolTally,
  withDb,
  type World,
} from '../_helpers/agent-memories-world.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

// Every sync asks git for each folder's layout in a child process.
vi.setConfig({ testTimeout: 20_000 });

const HELD = 'Run the schema check before this service deploys.';
const MERGED = 'Pin the node version in the CI workflow file.';
const OTHER_TENANT = 'Rotate the deploy key every ninety days.';
const SUPERSEDED = 'Restart the worker after every deploy.';
const NEW = 'Cache the build output between pipeline runs.';
const NOTES = [HELD, MERGED, OTHER_TENANT, SUPERSEDED, NEW];

let w: World;
beforeEach(() => {
  w = openWorld();
  NOTES.forEach((text, i) => note(projectNotes(w), `note-${i}.md`, text));
});
afterEach(() => {
  closeWorld(w);
  vi.unstubAllEnvs();
});

const row = (content: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
  ...createMemory(content, { layer: Layer.Semantic }),
  ...extra,
});

function write(rows: readonly MemoryEntry[]): void {
  withDb(w.local, (db) => {
    db.exec('BEGIN');
    for (const entry of rows) writeEntryDbOnly(db, entry);
    db.exec('COMMIT');
  });
}

function seed(): void {
  write([
    row('  Run the   schema check\nbefore this service deploys.  '),
    row(mergedText('[Consolidated from 2 related memories, newest first]', [MERGED, 'Tag every release.']), {
      source: 'consolidation',
    }),
    row(OTHER_TENANT, { tenantId: 'acme' }),
    row(SUPERSEDED, { supersededBy: 'mem_newer' }),
  ]);
}

const sync = (dryRun: boolean): ImportReport =>
  importForStore(w.local, {
    configAt: loadConfig,
    tenantId: 'default',
    agentImport: sqliteAgentImport({}),
    machine: w.machine,
    dryRun,
  });

describe('agent memory sync duplicate check', () => {
  it.each([true, false])('skips exactly the texts another path holds, index in sync: %s', (inSync) => {
    seed();
    withDb(w.local, (db) => setFtsInSync(db, inSync));

    const { result, statements } = recordStatements(() => sync(false));

    expect(countMatching(statements, 'memories_fts MATCH') > 0).toBe(inSync);
    expect(toolTally(result, 'claude-code')).toMatchObject({ imported: 3, duplicate: 2 });
    expect(liveTexts(w.local)).toEqual([NEW, OTHER_TENANT, SUPERSEDED].sort());
  });

  it('reads no more rows with 500 stored rows that hold none of the notes', () => {
    const rowsRead = (inSync: boolean): number => {
      withDb(w.local, (db) => setFtsInSync(db, inSync));
      return recordStatements(() => sync(true)).rowsRead;
    };
    seed();
    const before = [rowsRead(true), rowsRead(false)];

    write(Array.from({ length: 500 }, (_, k) => row(`xyzzy plugh ${k}`)));

    expect([rowsRead(true), rowsRead(false)]).toEqual(before);
  });
});
