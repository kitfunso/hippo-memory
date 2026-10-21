// The disk reads the agent-memory adapters make, as a port: src/infra/agent-files.ts reads the disk, and the adapters
// hold no file handle.

export type TextFile =
  | { readonly ok: true; readonly text: string; readonly mtimeMs: number }
  | { readonly ok: false; readonly reason: string };

export type DirListing =
  | { readonly status: 'ok'; readonly files: readonly string[] }
  | { readonly status: 'missing' }
  | { readonly status: 'unreadable'; readonly reason: string };

export interface AgentFiles {
  exists(p: string): boolean;
  /** True for a folder or a link to one; false when the path is missing. */
  isFolder(p: string): boolean;
  /** The folders directly in `dir`, sorted, links not followed; throws when `dir` cannot be read. */
  folderNames(dir: string): string[];
  /** Up to `bytes` from the start of a file as UTF-8; null when it is not there, and any other failure throws. */
  readHead(file: string, bytes: number): string | null;
  /** A file's text, or why it was skipped: empty, too big, holds a NUL byte (not text), or unreadable. */
  readText(file: string): TextFile;
  /** Files in a folder as '/'-separated relative paths, sorted; dot entries skipped, linked folders not followed. */
  listFiles(dir: string, opts: { readonly recursive: boolean }): DirListing;
  /** The path with links and junctions followed and, on Windows, its case as the disk has it; resolved when missing. */
  realPath(p: string): string;
}
