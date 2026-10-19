// One memory with every MemoryEntry field set to a value that is not its default, for the wire-format goldens.
import { Layer, type MemoryEntry } from '../../src/core/memory.js';

export const GOLDEN_TENANT = 'acme';

/** Every field set, in the order a store read builds them; superseded, scoped and a level-2 summary, so recall hides
 * it. */
export function everyFieldEntry(): MemoryEntry {
  return {
    id: 'mem-golden-every',
    created: '2026-01-10T09:00:00.000Z',
    lastRetrieved: '2026-01-20T10:00:00.000Z',
    retrievalCount: 4,
    strength: 0.8125,
    halfLifeDays: 21,
    layer: Layer.Episodic,
    tags: ['wire', 'golden'],
    emotionalValence: 'positive',
    schemaFit: 0.65,
    source: 'cli',
    outcomeScore: 0.5,
    outcomePositive: 3,
    outcomeNegative: 1,
    conflictsWith: ['mem-golden-other'],
    pinned: true,
    confidence: 'observed',
    content: 'the wire golden keeps every stored key in its place',
    parents: ['mem-golden-parent'],
    starred: true,
    traceOutcome: 'success',
    sourceSessionId: 'sess-golden',
    validFrom: '2026-01-11T00:00:00.000Z',
    supersededBy: 'mem-golden-newer',
    extractedFrom: 'mem-golden-source',
    dagLevel: 2,
    dagParentId: 'mem-golden-topic',
    kind: 'distilled',
    scope: 'project:golden',
    owner: 'user:golden',
    artifactRef: 'gh://kitfunso/hippo-memory/pull/1',
    tenantId: GOLDEN_TENANT,
    originProject: 'golden',
    descendantCount: 7,
    earliestAt: '2025-12-01T00:00:00.000Z',
    latestAt: '2026-01-09T00:00:00.000Z',
    summaryDirty: true,
    lastRebuiltAt: '2026-01-12T00:00:00.000Z',
    rebuildCount: 2,
    dagLevel3BuiltAt: '2026-01-13T00:00:00.000Z',
    bm25Score: -3.25,
  };
}

/** The same fields, less the four that hide a row from recall: supersession, a scope, a summary level, a project. */
export function recallableEntry(): MemoryEntry {
  return {
    ...everyFieldEntry(),
    id: 'mem-golden-recall',
    content: 'the haddock wire golden reads back through recall',
    supersededBy: null,
    scope: null,
    dagLevel: 0,
    originProject: '',
  };
}
