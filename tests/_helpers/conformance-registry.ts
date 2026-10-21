// The test files that run each required store group, and the store's own methods, on hippo.db and on memoryStore;
// the Record type fails the typecheck when a group is added to the port without one.
import type { ConformanceGroup } from './store-conformance.js';

export const CONFORMANCE_FILES = {
  base: ['tests/store/base-conformance.test.ts'],
  sessions: ['tests/store/sessions-conformance.test.ts'],
  cards: ['tests/store/cards-goals-conformance.test.ts'],
  goals: ['tests/store/cards-goals-conformance.test.ts'],
  conflicts: ['tests/store/conflicts-dormant-conformance.test.ts'],
  dormant: ['tests/store/conflicts-dormant-conformance.test.ts'],
  reports: ['tests/core/reports-conformance.test.ts'],
  rejections: ['tests/core/rejections-conformance.test.ts'],
  failureLog: ['tests/entry/failure-log-conformance.test.ts'],
  compactions: ['tests/entry/compactions-conformance.test.ts'],
  auditMaintenance: ['tests/store/audit-maintenance-conformance.test.ts'],
  lessonWrites: ['tests/store/lesson-grant-writes-conformance.test.ts', 'tests/entry/failure-log-conformance.test.ts'],
  vectors: ['tests/server/recall-vector-reads-parity.server.test.ts'],
  keyAudit: ['tests/entry/key-audit-conformance.test.ts'],
  keyWrites: ['tests/store/key-writes-conformance.test.ts'],
  keyGrants: ['tests/store/lesson-grant-writes-conformance.test.ts'],
  vectorWrites: ['tests/db/vector-writes-conformance.test.ts'],
  entryWrites: ['tests/entry/entry-writes-conformance.test.ts'],
  contextReads: ['tests/store/context-reads-conformance.test.ts', 'tests/core/context-store-path-parity.test.ts'],
  predictions: ['tests/store/predictions-conformance.test.ts'],
  dagReads: ['tests/store/dag-reads-conformance.server.test.ts'],
  auditLog: ['tests/store/audit-log-conformance.server.test.ts'],
  quarantine: ['tests/store/quarantine-conformance.test.ts'],
  graphReads: ['tests/store/graph-reads-conformance.test.ts'],
  connectorWrites: ['tests/connectors/connector-writes-conformance.test.ts'],
  connectorEvents: ['tests/connectors/connector-events-conformance.test.ts'],
  objects: [
    'tests/objects/objects-conformance.test.ts',
    'tests/objects/objects-conformance-incidents.test.ts',
    'tests/objects/objects-conformance-lookups.test.ts',
    'tests/objects/objects-conformance-transaction.test.ts',
  ],
} as const satisfies Readonly<Record<ConformanceGroup, readonly string[]>>;
