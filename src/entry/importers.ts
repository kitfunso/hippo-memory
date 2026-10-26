// The published importers take a folder in their options, so this entry builds the hippo.db store each one writes to.
import {
  importEntriesInto,
  importRoot,
  type ImportOptions,
  type ImportResult,
  type TargetedImport,
} from '../surface/importers/core.js';
import * as sources from '../surface/importers/sources.js';
import { importMarkdownInto } from '../surface/importers/markdown.js';
import { importVaultInto } from '../surface/importers/vault.js';
import { defaultImportFiles, defaultStore, runStoreBatch, runStoreRequest } from '../surface/open-store.js';
import { entryInfra } from '../surface/entry-infra.js';
import { evalClock } from '../infra/eval-switches.js';

function targeted(options: ImportOptions): TargetedImport {
  const root = importRoot(options);
  return { ...options, target: { root, files: defaultImportFiles(root), batch: runStoreBatch, clock: evalClock() } };
}

/** Given an array of raw text chunks, deduplicate against existing memories, create MemoryEntry objects, write them
 *  (unless dry-run), and return a result. */
export function importEntries(chunks: string[], source: string, tags: string[], options: ImportOptions): ImportResult {
  return importEntriesInto(chunks, source, tags, targeted(options));
}

export function importChatGPT(filePath: string, options: ImportOptions): ImportResult {
  return sources.importChatGPTInto(filePath, targeted(options));
}

export function importClaude(filePath: string, options: ImportOptions): ImportResult {
  return sources.importClaudeInto(filePath, targeted(options));
}

/** Import `.cursorrules`, one rule file, or a `.cursor/rules` tree of `.mdc` and `.md` rules. */
export function importCursor(sourcePath: string, options: ImportOptions): ImportResult {
  return sources.importCursorInto(sourcePath, targeted(options));
}

export function importGenericFile(filePath: string, options: ImportOptions): ImportResult {
  return sources.importGenericFileInto(filePath, targeted(options));
}

export function importMarkdown(filePath: string, options: ImportOptions): ImportResult {
  return importMarkdownInto(filePath, targeted(options));
}

/** Import a markdown vault FOLDER as `kind='raw'` memories. NOT re-entrant: idempotency rests on the in-memory
 * `existing` Map loaded once, so two concurrent runs over one vault can double-insert. */
export function importVault(folderPath: string, options: ImportOptions): Promise<ImportResult> {
  const batch = <T>(run: () => Promise<T>): Promise<T> => runStoreRequest(run, 'cli');
  return importVaultInto(folderPath, options, { store: defaultStore(options.hippoRoot), batch, infra: entryInfra() });
}
export type { ImportResult, ImportOptions } from '../surface/importers/core.js';
