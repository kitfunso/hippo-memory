// The conformance suite's second side: memoryStore over a copy of the fixture folder's rows, with reads of the
// tables a test compares to hippo.db's and the name of every store method it was called with.
import type { HippoStore } from '../../src/store/index.js';
import { memoryStore } from '../../src/store/memory/store.js';
import type { LoggedEvent, MemoryTables, ParkedLetter } from '../../src/store/memory/tables.js';
import type { HeldRecord } from './connector-sides.js';
import { loadTables } from './memory-tables.js';
import type { StoreSide } from './store-conformance.js';

export interface MemorySide extends StoreSide {
  readonly tables: MemoryTables;
  /** The name of each recall and context read the store answered, in call order. */
  readonly calls: readonly string[];
  readonly events: () => readonly LoggedEvent[];
  readonly records: () => readonly HeldRecord[];
  readonly letters: () => readonly ParkedLetter[];
  readonly forgotten: () => number;
}

const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** The store with each read recall and context make logged by name: the two base reads, contextReads and vectors. */
function logged(store: HippoStore, calls: string[]): HippoStore {
  const log =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      calls.push(name);
      return fn(...args);
    };
  const { contextReads: c, vectors: v } = store;
  return {
    ...store,
    continuity: log('continuity', store.continuity),
    searchRecallEntries: log('searchRecallEntries', store.searchRecallEntries),
    contextReads: {
      unfinishedHandoff: log('unfinishedHandoff', c.unfinishedHandoff),
      ambientCandidates: log('ambientCandidates', c.ambientCandidates),
      contextCandidates: log('contextCandidates', c.contextCandidates),
      ambientTallies: log('ambientTallies', c.ambientTallies),
      newestEntries: log('newestEntries', c.newestEntries),
      schemaFit: log('schemaFit', c.schemaFit),
      liveContentsBySourceAndTag: log('liveContentsBySourceAndTag', c.liveContentsBySourceAndTag),
      rawRowsUnderRef: log('rawRowsUnderRef', c.rawRowsUnderRef),
    },
    vectors: {
      embeddingIndexState: log('embeddingIndexState', v.embeddingIndexState),
      storedVectors: log('storedVectors', v.storedVectors),
      nearestEntries: log('nearestEntries', v.nearestEntries),
      physicsParticles: log('physicsParticles', v.physicsParticles),
    },
  };
}

/** As hippo.db's tables answer a SELECT ordered by connector DESC, then the key or id. */
const slackFirst = (a: { connector: string }, b: { connector: string }): number =>
  a.connector === b.connector ? 0 : a.connector === 'slack' ? -1 : 1;

/** memoryStore over the rows of the hippo.db folder at `hippoRoot`, which it never opens again. */
export function memorySide(hippoRoot: string): MemorySide {
  const tables = loadTables(hippoRoot);
  const calls: string[] = [];
  const store = logged(memoryStore(tables), calls);
  return {
    store,
    tables,
    calls,
    auditRows: () => structuredClone(tables.audit),
    events: () => [...tables.connectorLog.values()].sort((a, b) => slackFirst(a, b) || byBytes(a.eventKey, b.eventKey)),
    records: () =>
      tables.quarantine
        .map(({ decidedAt: _at, decidedBy: _by, ...held }) => ({ ...held }))
        .sort((a, b) => byBytes(a.quarantinedAt, b.quarantinedAt) || byBytes(a.memoryId, b.memoryId)),
    letters: () => [...tables.deadLetters].sort((a, b) => slackFirst(a, b) || a.id - b.id),
    forgotten: () => Number(tables.meta.get('total_forgotten') ?? '0'),
  };
}
