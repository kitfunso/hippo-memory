// hippo.db's local tier: the features only this store serves, as repositories typed by their SQL
// bodies. No other store implements them, so none is part of the store port.
import { sqliteConflicts } from './review/conflicts.js';
import { CONFLICTS_EFFECTS } from '../../base/ports/store/conflicts.js';
import { sqliteReports } from './reports/reports.js';
import { REPORTS_EFFECTS } from '../../base/ports/store/reports.js';
import { sqliteLastRecall } from './recall/last-recall.js';
import { LAST_RECALL_EFFECTS } from '../../base/ports/store/recall-writes.js';
import { sqliteRejections } from './review/rejections.js';
import { REJECTIONS_EFFECTS } from '../../base/ports/store/rejections.js';
import { sqliteConnectorEvents } from './connectors/connector-events.js';
import { sqliteConnectorWrites } from './connectors/connector-writes.js';
import {
  CONNECTOR_WRITES_EFFECTS,
  CONNECTOR_EVENTS_EFFECTS,
} from '../../base/ports/store/connectors.js';
import { AUDIT_MAINTENANCE_EFFECTS } from '../../base/ports/store/audit.js';
import { sqliteAuditMaintenance } from './audit/audit-maintenance.js';
import type { HippoStore, StoreGroups } from '../../base/ports/store.js';
import type { MethodEffects } from '../../base/ports/store/effects.js';
import { SESSIONS_EFFECTS } from '../../base/ports/store/sessions.js';
import { sqliteQuarantine } from './connectors/quarantine.js';
import { sqliteStats } from './entries/index-and-stats.js';
import { sqliteSessions } from './sessions/sessions.js';
import type { Handles } from './runtime/open.js';

/** Every local repository on `handles`; the SQLite store carries them as `hippoDb`. */
export function hippoDbRepos(handles: Handles) {
  return {
    stats: sqliteStats(handles),
    quarantine: sqliteQuarantine(handles),
    sessions: sqliteSessions(handles),
    auditMaintenance: sqliteAuditMaintenance(handles),
    connectorWrites: sqliteConnectorWrites(handles),
    connectorEvents: sqliteConnectorEvents(handles.on),
    rejections: sqliteRejections(handles),
    lastRecall: sqliteLastRecall(handles),
    reports: sqliteReports(handles),
    conflicts: sqliteConflicts(handles),
  };
}

export type HippoDbRepos = ReturnType<typeof hippoDbRepos>;

/** A store that carries the local tier. */
export interface HippoDbTier {
  readonly hippoDb: HippoDbRepos;
}

/** hippo.db's own store: the port with every optional group, and the local tier. */
export type HippoDbStore = HippoStore & StoreGroups & HippoDbTier;

/** What each local method does to the store, which places it on a worker; a method missing here
 * fails to compile. */
export const HIPPO_DB_EFFECTS = {
  stats: { bumpRemembered: 'write' },
  quarantine: { list: 'read', approve: 'write', reject: 'write' },
  sessions: SESSIONS_EFFECTS,
  auditMaintenance: AUDIT_MAINTENANCE_EFFECTS,
  connectorWrites: CONNECTOR_WRITES_EFFECTS,
  connectorEvents: CONNECTOR_EVENTS_EFFECTS,
  rejections: REJECTIONS_EFFECTS,
  lastRecall: LAST_RECALL_EFFECTS,
  reports: REPORTS_EFFECTS,
  conflicts: CONFLICTS_EFFECTS,
} as const satisfies { readonly [R in keyof HippoDbRepos]: MethodEffects<HippoDbRepos[R]> };
