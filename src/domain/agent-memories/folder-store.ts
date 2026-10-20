// A folder whose files are the items, as Claude Code, Gemini, Qwen and Copilot keep them: one reader for all four.
import path from 'node:path';
import { listFiles, readTextFile } from './files.js';
import type { Container, MemoryItem, Scope } from './types.js';

export interface FolderRules {
  readonly recursive: boolean;
  readonly include: (rel: string) => boolean;
  /** The stored text and time of a file read in full, or null when the tool would not count it as a note. */
  readonly item: (text: string, mtimeMs: number) => { readonly text: string; readonly updatedAt: number } | null;
}

/** Null when the folder is missing; a file that could not be read is `skipped`, so its row is left alone. */
export function readFolderStore(dir: string, scope: Scope, rules: FolderRules): Container | null {
  const listing = listFiles(dir, { recursive: rules.recursive });
  if (listing.status === 'missing') return null;
  if (listing.status === 'unreadable') {
    return { scope, path: dir, readable: false, items: [], skipped: [], warnings: [listing.reason], textKeyed: false };
  }
  const items: MemoryItem[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
  for (const key of listing.files.filter(rules.include)) {
    const file = readTextFile(path.join(dir, key));
    if (!file.ok) {
      skipped.push(key);
      warnings.push(file.reason);
      continue;
    }
    const item = rules.item(file.text, file.mtimeMs);
    if (item !== null) items.push({ key, ...item });
  }
  return { scope, path: dir, readable: true, items, skipped, warnings, textKeyed: false };
}

/** Markdown notes directly in, or anywhere under, the folder, with the tool's index file left out. */
export function markdownNotes(rel: string): boolean {
  return rel.endsWith('.md') && rel !== 'MEMORY.md';
}

/** Each folder once, compared case-insensitively on win32 as the file system does. */
export function uniqueFolders(folders: readonly string[], platform: NodeJS.Platform): string[] {
  const seen = new Set<string>();
  return folders.filter((folder) => {
    const resolved = path.resolve(folder);
    const key = platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
