// memoryStore: a supported store shipped from hippo-memory/store-kit, every required port group over plain tables in
// this process. CI runs the server and MCP suites on it, and the store conformance suite holds it to the port.
import type { LossAversion } from '../../base/memory/memory.js';
import type { HippoStore } from '../port.js';
import { memoryAuditLog } from './audit-log.js';
import { memoryAuditMaintenance } from './audit-maintenance.js';
import { continuityIn, entriesByIdsIn, freshRawIn, planningEvidenceIn } from './base-reads.js';
import { memoryCards } from './cards.js';
import { memoryCompactions } from './compactions.js';
import { memoryConflicts } from './conflicts.js';
import { memoryConnectorEvents } from './connector-events.js';
import { memoryConnectorWrites } from './connector-writes.js';
import { memoryContextReads } from './context-reads.js';
import { memoryDagReads } from './dag-reads.js';
import { memoryDormant } from './dormant.js';
import { memoryEntryWrites } from './entry-writes.js';
import { memoryFailureLog } from './failure-log.js';
import { activeGoalsIn, memoryGoals } from './goals.js';
import { memoryGraphReads } from './graph-reads.js';
import { memoryKeyAudit } from './key-audit.js';
import { memoryKeyGrants } from './key-grants.js';
import { apiKeyRecord, memoryKeyWrites } from './key-writes.js';
import { memoryLessonWrites } from './lesson-writes.js';
import { memoryObjects } from './objects.js';
import { memoryPredictions } from './predictions.js';
import { memoryQuarantine } from './quarantine.js';
import { finishRecallIn } from './recall-writes.js';
import { memoryRejections } from './rejections.js';
import { memoryReports } from './reports.js';
import { appendAudit, bumpCounter } from './rows.js';
import { searchRecallIn } from './search.js';
import { memorySessions } from './sessions.js';
import { emptyTables, type MemoryTables } from './tables.js';
import { recordTokensIn } from './token-ledger.js';
import { memoryVectorWrites } from './vector-writes.js';
import { memoryVectors } from './vectors.js';

type BaseKey =
  | 'findApiKey'
  | 'searchRecallEntries'
  | 'entriesByIds'
  | 'activeGoals'
  | 'freshRawEntries'
  | 'continuity'
  | 'planningFallacyEvidence'
  | 'appendAuditEvents'
  | 'finishRecall'
  | 'bumpRecallStats'
  | 'recordTokens'
  | 'close';

function baseMethods(t: MemoryTables, rules: LossAversion): Pick<HippoStore, BaseKey> {
  return {
    findApiKey: async (keyId) => apiKeyRecord(t, keyId),
    searchRecallEntries: async (query, args) => searchRecallIn(t, query, args),
    entriesByIds: async (ids, tenantId) => entriesByIdsIn(t, ids, tenantId),
    activeGoals: async (opts) => activeGoalsIn(t, opts),
    freshRawEntries: async (count, tenantId, sessionId, origins) => freshRawIn(t, count, tenantId, sessionId, origins),
    continuity: async (tenantId, eventLimit, key) => continuityIn(t, tenantId, eventLimit, key),
    planningFallacyEvidence: async (tenantId, tokens) => planningEvidenceIn(t, tenantId, tokens),
    appendAuditEvents: async (events) => appendAudit(t, events),
    finishRecall: async (writes) => finishRecallIn(t, writes, rules),
    bumpRecallStats: async (recalled) => bumpCounter(t, 'total_recalled', recalled),
    recordTokens: async (use) => recordTokensIn(t, use),
    close: async () => undefined,
  };
}

/** A store of every required group over `tables`, which the caller may seed and read; optional groups stay unset. */
export function memoryStore(tables: MemoryTables = emptyTables(), rules: LossAversion = {}): HippoStore {
  const t = tables;
  return {
    kind: 'memory',
    ...baseMethods(t, rules),
    sessions: memorySessions(t),
    cards: memoryCards(t),
    goals: memoryGoals(t),
    conflicts: memoryConflicts(t),
    dormant: memoryDormant(t),
    reports: memoryReports(t, rules),
    rejections: memoryRejections(t),
    failureLog: memoryFailureLog(t),
    compactions: memoryCompactions(t),
    lessonWrites: memoryLessonWrites(t),
    auditMaintenance: memoryAuditMaintenance(t, rules),
    vectors: memoryVectors(t),
    keyAudit: memoryKeyAudit(t),
    keyWrites: memoryKeyWrites(t),
    keyGrants: memoryKeyGrants(t),
    vectorWrites: memoryVectorWrites(t),
    entryWrites: memoryEntryWrites(t),
    contextReads: memoryContextReads(t),
    predictions: memoryPredictions(t),
    dagReads: memoryDagReads(t),
    auditLog: memoryAuditLog(t),
    quarantine: memoryQuarantine(t),
    graphReads: memoryGraphReads(t),
    connectorWrites: memoryConnectorWrites(t),
    objects: memoryObjects(t),
    connectorEvents: memoryConnectorEvents(t),
  };
}
