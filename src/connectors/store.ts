import type { ContextWith } from '../api/index.js';
import type { StoreWith } from '../store/index.js';

/** The groups a connector delivery writes through; the webhook gate proves all three before any delivery runs. */
type ConnectorGroup = 'entryWrites' | 'connectorWrites' | 'connectorEvents';

export type ConnectorStore = StoreWith<ConnectorGroup>;
export type ConnectorContext = ContextWith<ConnectorGroup>;
