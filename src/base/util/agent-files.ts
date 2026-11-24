export type TextFile =
  | { readonly ok: true; readonly text: string; readonly mtimeMs: number }
  | { readonly ok: false; readonly reason: string };

export type DirListing =
  | { readonly status: 'ok'; readonly files: readonly string[] }
  | { readonly status: 'missing' }
  | { readonly status: 'unreadable'; readonly reason: string };

export interface AgentFiles {
  exists(p: string): boolean;
  isFolder(p: string): boolean;
  folderNames(dir: string): string[];
  readHead(file: string, bytes: number): string | null;
  readText(file: string): TextFile;
  listFiles(dir: string, opts: { readonly recursive: boolean }): DirListing;
  realPath(p: string): string;
}
