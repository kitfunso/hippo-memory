import type { Actor } from '../../api/index.js';
import type { EntryInfraPorts } from '../../api/types.js';
import type { CallerState } from '../../api/callers.js';
import type { HippoConfig } from '../../base/config/config.js';
import type { InfraPorts } from '../../base/ports/infra.js';
import type { HippoStore } from '../../base/ports/store-index.js';
import { requireGroups } from '../../base/ports/store.js';
import type { DetachedWork } from '../../domain/search/detached-work.js';
import {
  CONNECTOR_GROUPS,
  type ConnectorContext,
  type ConnectorStore,
} from '../connectors/ingest.js';
import { cliApiContext, cliStore } from './api-context.js';

/** Where a slack or github verb reads and writes: the CLI's hippo.db, or a store a published entry was handed. */
export interface ConnectorSource {
  readonly tenantId: string;
  readonly store: () => ConnectorStore;
  readonly context: (actor: Actor) => ConnectorContext;
}

/** What `runConnectorCommand` takes: the store and tenant a verb runs on, with the config and ports
 * of the root that opened the store. */
export interface ConnectorEntryContext {
  readonly tenantId: string;
  readonly store: HippoStore;
  readonly config: HippoConfig;
  /** The machine, model and embedder ports; unset, the entry fills in the real ones. */
  readonly infra?: EntryInfraPorts;
  /** The root's per-caller state; with an auto-sleep host in it a write starts auto-sleep. */
  readonly callers?: CallerState;
  /** Where the root settles work a call hands off, such as an embed. */
  readonly detached?: DetachedWork;
}

export function cliConnectorSource(hippoRoot: string, tenantId: string): ConnectorSource {
  return {
    tenantId,
    store: () => cliStore(hippoRoot),
    context: (actor) => ({ ...cliApiContext(hippoRoot, tenantId), actor }),
  };
}

export function entryConnectorSource(
  ctx: ConnectorEntryContext & { readonly infra: InfraPorts },
): ConnectorSource {
  const store = requireGroups(ctx.store, CONNECTOR_GROUPS);
  return {
    tenantId: ctx.tenantId,
    store: () => store,
    context: (actor) => ({ ...ctx, store, actor }),
  };
}
