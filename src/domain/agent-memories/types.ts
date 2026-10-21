// The contract between a tool's adapter, which knows where its memory lives, and the sync, which knows no tool.
import type { ToolId } from '../../base/memory/agent-memory-tools.js';
import type { Machine } from '../../base/util/agent-homes.js';
import type { StoreWith } from '../../store/port.js';

export type Scope = 'project' | 'user';

/** All an adapter may know about the machine, its disk and git included; it reads nothing else, so tests can fake it
 * all. */
export interface AdapterContext extends Machine {
  readonly projectRoot?: string;
}

export interface MemoryItem {
  /** A path inside the container with '/' separators, or `<heading slug>/<text hash>` in a single-file store. */
  readonly key: string;
  readonly text: string;
  readonly updatedAt: number;
}

/** A folder, or one file's memory section, that exists on disk. */
export interface Container {
  readonly scope: Scope;
  readonly path: string;
  /** False when it exists but could not be read or failed its shape check, so nothing in it is set aside. */
  readonly readable: boolean;
  readonly items: readonly MemoryItem[];
  /** Keys of items on disk that were not read (too big, not text, a failed read); their rows are left alone. */
  readonly skipped: readonly string[];
  readonly warnings: readonly string[];
  /** Keys made from text, so an edit is matched by heading rather than by key. */
  readonly textKeyed: boolean;
}

export interface Listing {
  readonly tool: ToolId;
  readonly home: string;
  readonly containers: readonly Container[];
  /** Problems finding containers, such as a malformed index file; an unlisted container is left alone. */
  readonly warnings: readonly string[];
}

export interface Adapter {
  readonly tool: ToolId;
  list(ctx: AdapterContext, scope: Scope): Listing;
}

/** One store a sync reads and writes; the sync closes it. */
export type ImportStore = StoreWith<'agentImport' | 'projectTags'>;

/** How a sync reaches each store it targets: the caller's, so the sync never names a store adapter. */
export interface ImportStores {
  /** `root`'s store; a set `busyWaitMs` is how long its container writes wait on a locked store. */
  open(root: string, opts: { readonly busyWaitMs?: number }): ImportStore;
  /** Creates the store at `root` with its folders. */
  create(root: string): Promise<void>;
  /** An empty store in a scratch folder a dry run plans against; closing it deletes the folder. */
  standIn(): ImportStore;
  /** Whether `err` is a store that stayed locked past its wait; the sync skips that store and goes on. */
  isBusy<E>(err: E): boolean;
}
