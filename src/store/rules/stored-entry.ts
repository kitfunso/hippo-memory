// The memories columns' defaults, once: hippo.db applies them reading a row back, the memory store writing one, so both
// adapters return the same entry for the same write.
import {
  DEFAULT_SCHEMA_FIT,
  FALLBACK_HALF_LIFE_DAYS,
  type ConfidenceLevel,
  type EmotionalValence,
  type MemoryEntry,
  type MemoryKind,
  type TraceOutcome,
} from '../../base/memory/memory.js';

type Count = number | null | undefined;
type Flag = boolean | number | null | undefined;
type Text = string | null | undefined;

/** A memories row in MemoryEntry's names, its JSON lists parsed; each column with a default may be absent or null. */
export interface StoredColumns extends Pick<
  MemoryEntry,
  'id' | 'created' | 'lastRetrieved' | 'layer' | 'content' | 'tenantId'
> {
  readonly tags: string[];
  readonly conflictsWith: string[];
  readonly parents: string[];
  readonly retrievalCount?: Count;
  readonly strength?: Count;
  readonly halfLifeDays?: Count;
  readonly schemaFit?: Count;
  readonly outcomeScore?: Count;
  readonly outcomePositive?: Count;
  readonly outcomeNegative?: Count;
  readonly dagLevel?: Count;
  readonly descendantCount?: Count;
  readonly rebuildCount?: Count;
  readonly pinned?: Flag;
  readonly starred?: Flag;
  readonly summaryDirty?: Flag;
  readonly emotionalValence?: EmotionalValence | null;
  readonly source?: Text;
  readonly confidence?: ConfidenceLevel | null;
  readonly traceOutcome?: TraceOutcome | null;
  readonly kind?: MemoryKind | null;
  readonly validFrom?: Text;
  readonly sourceSessionId?: Text;
  readonly supersededBy?: Text;
  readonly extractedFrom?: Text;
  readonly dagParentId?: Text;
  readonly scope?: Text;
  readonly owner?: Text;
  readonly artifactRef?: Text;
  readonly originProject?: Text;
  readonly earliestAt?: Text;
  readonly latestAt?: Text;
  readonly lastRebuiltAt?: Text;
  readonly dagLevel3BuiltAt?: Text;
}

function retrievalFields(c: StoredColumns) {
  return {
    id: c.id,
    created: c.created,
    lastRetrieved: c.lastRetrieved,
    retrievalCount: Number(c.retrievalCount ?? 0),
    strength: Number(c.strength ?? 1),
    halfLifeDays: Number(c.halfLifeDays ?? FALLBACK_HALF_LIFE_DAYS),
    layer: c.layer,
    tags: c.tags,
    emotionalValence: c.emotionalValence ?? 'neutral',
    schemaFit: Number(c.schemaFit ?? DEFAULT_SCHEMA_FIT),
    source: c.source ?? 'cli',
    outcomeScore: c.outcomeScore === null || c.outcomeScore === undefined ? null : Number(c.outcomeScore),
    outcomePositive: Number(c.outcomePositive ?? 0),
    outcomeNegative: Number(c.outcomeNegative ?? 0),
    conflictsWith: c.conflictsWith,
    pinned: Boolean(c.pinned),
    confidence: c.confidence ?? 'observed',
    content: c.content,
    parents: c.parents,
    starred: Boolean(c.starred),
    traceOutcome: c.traceOutcome ?? null,
  } satisfies Partial<MemoryEntry>;
}

function placementFields(c: StoredColumns) {
  return {
    sourceSessionId: c.sourceSessionId ?? null,
    validFrom: c.validFrom ?? c.created,
    supersededBy: c.supersededBy ?? null,
    extractedFrom: c.extractedFrom ?? null,
    dagLevel: Number(c.dagLevel ?? 0),
    dagParentId: c.dagParentId ?? null,
    kind: c.kind ?? 'distilled',
    scope: c.scope ?? null,
    owner: c.owner ?? null,
    artifactRef: c.artifactRef ?? null,
    tenantId: c.tenantId,
    originProject: c.originProject ?? null,
    descendantCount: Number(c.descendantCount ?? 0),
    earliestAt: c.earliestAt ?? null,
    latestAt: c.latestAt ?? null,
    summaryDirty: Number(c.summaryDirty ?? 0) === 1,
    lastRebuiltAt: c.lastRebuiltAt ?? null,
    rebuildCount: Number(c.rebuildCount ?? 0),
    dagLevel3BuiltAt: c.dagLevel3BuiltAt ?? null,
  } satisfies Partial<MemoryEntry>;
}

/** The entry a memories row reads back as, each unset column at hippo.db's default. */
export function storedEntry(c: StoredColumns): MemoryEntry {
  return { ...retrievalFields(c), ...placementFields(c) };
}
