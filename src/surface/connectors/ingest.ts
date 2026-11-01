// What every connector's ingest shares: its Context on the server's ports and the result it answers.

import type { Actor } from '../../api/types.js';
import { coreEnrichment, type HippoDbContext } from '../../api/hippo-db-context.js';
import type { HippoDbStore } from '../../base/ports/hippo-db.js';
import type { HippoConfig } from '../../base/config/config.js';
import type { InfraPorts } from '../../base/ports/infra.js';

/** A connector's event log and the writes that commit with an event live in hippo.db's local
 * tier, so a connector runs only on a store that has one. */
export type ConnectorStore = HippoDbStore;
export type ConnectorContext = HippoDbContext;

/** What the server hands a connector's webhook: the store, its config and the outside services. */
export interface WebhookPorts {
  store: ConnectorStore;
  config: HippoConfig;
  infra: InfraPorts;
}

/** A connector's Context on the server's ports: its writes count and start an auto-sleep through
 * the store's local tier, as any remember does. */
export function connectorContext(
  ports: WebhookPorts,
  tenantId: string,
  actor: Actor,
): ConnectorContext {
  const { store, config, infra } = ports;
  return { tenantId, actor, store, config, infra, enrich: coreEnrichment(store) };
}

export type IngestStatus = 'ingested' | 'duplicate' | 'skipped' | 'skipped_duplicate';

export interface IngestResult {
  status: IngestStatus;
  memoryId: string | null;
}
