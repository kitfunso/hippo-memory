// The contract between a tool's adapter, which knows where its memory lives, and the sync, which knows no tool.
import type { ToolId } from './tools.js';

export type Scope = 'project' | 'user';

/** All an adapter may know about the machine; it reads nothing else from the process, so tests can fake it all. */
export interface AdapterContext {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly projectRoot?: string;
  /** Claude Code's transcript at a hook: its folder's `memory/` holds that session's own notes. */
  readonly transcriptPath?: string;
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
