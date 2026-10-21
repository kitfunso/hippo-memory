// A memory as hippo.db reads it back after a write: its column defaults filled and its stamp normalized, so both
// adapters return the same entry for the same write.
import { isoInstant } from '../../base/memory/created-stamp.js';
import {
  DEFAULT_SCHEMA_FIT,
  FALLBACK_HALF_LIFE_DAYS,
  type MemoryEntry,
  type MemoryKind,
} from '../../base/memory/memory.js';
import { DEFAULT_TENANT_ID } from '../../base/util/tenant.js';

type Placement = Omit<MemoryEntry, RetrievalKey>;
type RetrievalKey =
  | 'id'
  | 'created'
  | 'lastRetrieved'
  | 'retrievalCount'
  | 'strength'
  | 'halfLifeDays'
  | 'layer'
  | 'tags'
  | 'emotionalValence'
  | 'schemaFit'
  | 'source'
  | 'outcomeScore'
  | 'outcomePositive'
  | 'outcomeNegative'
  | 'conflictsWith'
  | 'pinned'
  | 'confidence'
  | 'content'
  | 'parents'
  | 'starred'
  | 'traceOutcome';

// A JSON list column holds each item as text once it is read.
const textList = (items: readonly unknown[] | undefined): string[] => (items ?? []).map(String);

function retrievalFields(entry: MemoryEntry, created: string): Pick<MemoryEntry, RetrievalKey> {
  return {
    id: entry.id,
    created,
    lastRetrieved: entry.lastRetrieved,
    retrievalCount: Number(entry.retrievalCount ?? 0),
    strength: Number(entry.strength ?? 1),
    halfLifeDays: Number(entry.halfLifeDays ?? FALLBACK_HALF_LIFE_DAYS),
    layer: entry.layer,
    tags: textList(entry.tags),
    emotionalValence: entry.emotionalValence ?? 'neutral',
    schemaFit: Number(entry.schemaFit ?? DEFAULT_SCHEMA_FIT),
    source: entry.source ?? 'cli',
    outcomeScore: entry.outcomeScore === null || entry.outcomeScore === undefined ? null : Number(entry.outcomeScore),
    outcomePositive: Number(entry.outcomePositive ?? 0),
    outcomeNegative: Number(entry.outcomeNegative ?? 0),
    conflictsWith: textList(entry.conflictsWith),
    pinned: Boolean(entry.pinned),
    confidence: entry.confidence ?? 'observed',
    content: entry.content,
    parents: textList(entry.parents),
    starred: Boolean(entry.starred),
    traceOutcome: entry.traceOutcome ?? null,
  };
}

/** The rebuild-queue fields are the sleep rebuild's, so a row write keeps the stored row's. */
function placementFields(entry: MemoryEntry, created: string, prior: MemoryEntry | undefined): Placement {
  return {
    sourceSessionId: entry.sourceSessionId ?? null,
    validFrom: entry.validFrom ?? created,
    supersededBy: entry.supersededBy ?? null,
    extractedFrom: entry.extractedFrom ?? null,
    dagLevel: Number(entry.dagLevel ?? 0),
    dagParentId: entry.dagParentId ?? null,
    kind: (entry.kind ?? 'distilled') satisfies MemoryKind,
    scope: entry.scope ?? null,
    owner: entry.owner ?? null,
    artifactRef: entry.artifactRef ?? null,
    tenantId: entry.tenantId ?? DEFAULT_TENANT_ID,
    originProject: entry.originProject ?? null,
    descendantCount: Number(entry.descendantCount ?? 0),
    earliestAt: entry.earliestAt ?? null,
    latestAt: entry.latestAt ?? null,
    summaryDirty: prior?.summaryDirty ?? false,
    lastRebuiltAt: prior?.lastRebuiltAt ?? null,
    rebuildCount: prior?.rebuildCount ?? 0,
    dagLevel3BuiltAt: entry.dagLevel3BuiltAt ?? null,
  };
}

/** `entry` as a write over `prior` stores it; only toISOString stamps sort by time, so `created` is rewritten so. */
export function asStored(entry: MemoryEntry, prior: MemoryEntry | undefined): MemoryEntry {
  const created = isoInstant(entry.created) ?? entry.created;
  return { ...retrievalFields(entry, created), ...placementFields(entry, created, prior) };
}
