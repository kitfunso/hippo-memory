// The published importers take a folder in their options, so this entry builds the hippo.db store each one writes to.
import {
  importEntries as importInto,
  importRoot,
  type ImportOptions,
  type ImportResult,
  type TargetedImport,
} from '../importers/core.js';
import * as sources from '../importers/sources.js';
import { importMarkdown as importMarkdownInto } from '../importers/markdown.js';
import { importVault as importVaultInto } from '../importers/vault.js';
import { sqliteStore, sqliteSyncStore } from '../store/sqlite/store.js';

function targeted(options: ImportOptions): TargetedImport {
  const root = importRoot(options);
  return { ...options, target: { root, store: sqliteSyncStore(root) } };
}

/** Given an array of raw text chunks, deduplicate against existing memories,
 *  create MemoryEntry objects, write them (unless dry-run), and return a result. */
export function importEntries(chunks: string[], source: string, tags: string[], options: ImportOptions): ImportResult {
  return importInto(chunks, source, tags, targeted(options));
}

export function importChatGPT(filePath: string, options: ImportOptions): ImportResult {
  return sources.importChatGPT(filePath, targeted(options));
}

export function importClaude(filePath: string, options: ImportOptions): ImportResult {
  return sources.importClaude(filePath, targeted(options));
}

/** Import `.cursorrules`, one rule file, or a `.cursor/rules` tree of `.mdc` and `.md` rules. */
export function importCursor(sourcePath: string, options: ImportOptions): ImportResult {
  return sources.importCursor(sourcePath, targeted(options));
}

export function importGenericFile(filePath: string, options: ImportOptions): ImportResult {
  return sources.importGenericFile(filePath, targeted(options));
}

export function importMarkdown(filePath: string, options: ImportOptions): ImportResult {
  return importMarkdownInto(filePath, targeted(options));
}

/** Import a markdown vault FOLDER as `kind='raw'` memories. NOT re-entrant: idempotency rests on the in-memory
 * `existing` Map loaded once, so two concurrent runs over one vault can double-insert. */
export function importVault(folderPath: string, options: ImportOptions): Promise<ImportResult> {
  return importVaultInto(folderPath, options, sqliteStore(options.hippoRoot));
}
