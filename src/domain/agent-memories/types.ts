import type { Scope, ToolId } from '../../base/memory/agent-memory-tools.js';
import type { Machine } from '../../base/util/agent-homes.js';
import type { StoreWith } from '../../base/ports/store.js';

/** All an adapter may know about the machine, its disk and git included; it reads nothing else,
 * so tests can fake it all. */
export interface AdapterContext extends Machine {
  readonly projectRoot?: string;
}

export interface MemoryItem {
  readonly key: string;
  readonly text: string;
  readonly updatedAt: number;
  readonly title?: string;
  readonly flagged?: boolean;
}

/** A folder, or one file's memory section, that exists on disk. */
export interface Container {
  readonly scope: Scope;
  readonly path: string;
  readonly readable: boolean;
  readonly items: readonly MemoryItem[];
  readonly skipped: readonly string[];
  readonly warnings: readonly string[];
  readonly textKeyed: boolean;
}

export interface Listing {
  readonly tool: ToolId;
  readonly home: string;
  readonly containers: readonly Container[];
  readonly warnings: readonly string[];
}

export interface Adapter {
  readonly tool: ToolId;
  list(ctx: AdapterContext, scope: Scope): Listing;
}

/** One store a sync reads and writes; the sync closes it. */
export type ImportStore = StoreWith<'agentImport' | 'projectTags' | 'sharing' | 'rejections'>;

/** How a sync reaches each store it targets: the caller's, so the sync never names a store
 * adapter. */
export interface ImportStores {
  open(root: string, opts: { readonly busyWaitMs?: number }): ImportStore;
  exists(root: string): boolean;
  create(root: string): Promise<void>;
  standIn(): ImportStore;
  isBusy<E>(err: E): boolean;
}
