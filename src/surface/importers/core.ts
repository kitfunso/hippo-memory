import { ALL_TENANTS, DEFAULT_TENANT_ID, type TenantId } from '../../base/util/tenant.js';
import { createMemory, Layer, MemoryEntry } from '../../base/memory/entry.js';
import { duplicateKey, heldTextKeys } from '../../base/util/same-text.js';
import { getGlobalRoot } from '../../host/global-store.js';
import { RejectedValueError } from '../../base/errors/api-errors.js';
import { loadConfig } from '../../host/config-file.js';
import { vetSecrets } from '../../base/util/secret-detect.js';
import { log } from '../../base/util/log.js';
import { CLI_ACTOR } from '../../base/scope/actor.js';
import type { EntryWrites } from '../../base/ports/store/entry-writes.js';
import type { Rejections } from '../../base/ports/store/rejections.js';
import type { Sharing } from '../../base/ports/store/sharing.js';
import type { Clock } from '../../base/ports/infra.js';

const MIN_IMPORT_CHARS = 10;
const MAX_IMPORT_CHARS = 1000;

export interface ImportResult {
  total: number; // entries found in source
  imported: number; // actually imported (after dedup)
  skipped: number; // skipped as duplicates or too short
  /**
   * Entries refused by the rejection-value guard, kept apart from `skipped` (dedup) so a tombstoned
   * value is distinguishable in summaries. Optional because `ImportResult` is exported from the
   * package root and a required field breaks existing consumers; read sites use `?? 0`.
   */
  rejected?: number;
  /** K1 vault import: rows archived this run (changed + source-deleted). In a dryRun this is the would-be count (a true
   *  deletion-sync preview). */
  archived?: number;
  /** Entries stored with secret-shaped text redacted; optional for the same published-surface
   * reason as `rejected`. */
  redacted?: number;
  entries: MemoryEntry[];
}

export interface ImportOptions {
  dryRun?: boolean;
  global?: boolean;
  extraTags?: string[];
  hippoRoot: string;
  /** The tenant written as, DEFAULT_TENANT_ID when left out: the dedup read counts only its
   * entries, except under `global`, which counts every tenant's. */
  tenantId?: string;
  /**
   * K1 vault import only: logical vault name for the `vault:<name>` tag and `artifactRef` key.
   * REQUIRED by importVault (throws if missing or blank), because it keys the destructive deletion
   * sync and two vaults sharing a basename would clobber each other. LIKE-escaped by the loader.
   */
  name?: string;
  /** K1 vault import only. Memory scope stamped on every imported note. Defaults to null
   * (unscoped) when unset. */
  scope?: string;
}

type AtOnce<F> = F extends (...args: infer A) => Promise<infer R> ? (...args: A) => R : never;

/** The port calls an import makes on its folder's store, answered at once; a composition root
 * builds them. */
export interface ImportFiles {
  readonly ensure: () => void;
  readonly writeEntry: AtOnce<EntryWrites['writeEntry']>;
  readonly refusedAmong: AtOnce<Rejections['refusedAmong']>;
  readonly textKeysHolding: AtOnce<Sharing['textKeysHolding']>;
}

/** The folder an import writes to and its store's calls; a composition root builds it. */
export interface ImportTarget {
  readonly root: string;
  readonly batch: <T>(run: (files: ImportFiles) => T) => T;
  readonly clock: Clock;
}

/** `ImportOptions` with the store the import writes to. */
export type TargetedImport = ImportOptions & { readonly target: ImportTarget };

/** The folder an import writes to: the operator's global store under `global`, else `hippoRoot`. */
export function importRoot(options: ImportOptions): string {
  return options.global ? getGlobalRoot() : options.hippoRoot;
}

/** Given an array of raw text chunks, deduplicate against existing memories, create MemoryEntry objects, write them
 *  (unless dry-run), and return a result. */
export function importEntriesInto(
  chunks: string[],
  source: string,
  tags: string[],
  options: TargetedImport,
): ImportResult {
  const allTags = [...new Set([...tags, ...(options.extraTags ?? [])])];
  const baseHalfLifeDays = loadConfig(options.target.root).defaultHalfLifeDays;
  const newEntry = (chunk: string): MemoryEntry =>
    createImportEntry({ chunk, source, allTags, options, baseHalfLifeDays });

  return options.target.batch((files) =>
    importChunks(chunks, openImportTarget(options, files), options, newEntry),
  );
}

function importChunks(
  chunks: string[],
  target: OpenImport,
  options: TargetedImport,
  newEntry: (chunk: string) => MemoryEntry,
): ImportResult {
  let total = 0;
  let imported = 0;
  let skipped = 0;
  let rejected = 0;
  let redacted = 0;
  const entries: MemoryEntry[] = [];

  for (const raw of chunks) {
    const { chunk, wasRedacted } = prepareImportChunk(raw);

    const skip = skipReason(chunk, target);
    if (skip !== 'too-short') total++;
    if (skip !== null) {
      skipped++;
      continue;
    }

    const entry = newEntry(chunk);
    if (!writeOrProbeImport(target, entry, options)) {
      rejected++;
      continue;
    }
    if (!options.dryRun) target.written.add(duplicateKey(chunk));

    entries.push(entry);
    imported++;
    if (wasRedacted) redacted++;
  }

  return { total, imported, skipped, rejected, redacted, entries };
}

interface OpenImport {
  readonly targetRoot: string;
  readonly files: ImportFiles;
  readonly tenantId: TenantId;
  readonly written: Set<string>;
}

function openImportTarget(
  { global, tenantId, target }: TargetedImport,
  files: ImportFiles,
): OpenImport {
  if (global) files.ensure();
  const scope = global ? ALL_TENANTS : (tenantId ?? DEFAULT_TENANT_ID);
  return { targetRoot: target.root, files, tenantId: scope, written: new Set() };
}

function skipReason(chunk: string, target: OpenImport): 'too-short' | 'duplicate' | null {
  if (!chunk || chunk.length < MIN_IMPORT_CHARS) return 'too-short';
  if (target.written.has(duplicateKey(chunk)) || storeHolds(target, chunk)) return 'duplicate';
  return null;
}

function storeHolds({ files, tenantId }: OpenImport, chunk: string): boolean {
  const key = duplicateKey(chunk);
  return files
    .textKeysHolding({ tenantId }, [chunk])
    .some((row) => heldTextKeys(row).includes(key));
}

function prepareImportChunk(raw: string) {
  const original = raw.trim();
  const trimmed = vetSecrets(original).content;
  const wasRedacted = trimmed !== original;
  if (trimmed.length > MAX_IMPORT_CHARS) {
    log.warn(`imported memory truncated from ${trimmed.length} to ${MAX_IMPORT_CHARS} chars`);
  }
  return { chunk: trimmed.slice(0, MAX_IMPORT_CHARS), wasRedacted };
}

interface CreateImportEntryOptions {
  readonly chunk: string;
  readonly source: string;
  readonly allTags: string[];
  readonly options: TargetedImport;
  readonly baseHalfLifeDays: number;
}

function createImportEntry({
  chunk,
  source,
  allTags,
  options,
  baseHalfLifeDays,
}: CreateImportEntryOptions): MemoryEntry {
  return createMemory(
    chunk,
    {
      layer: Layer.Episodic,
      tags: allTags,
      source,
      confidence: 'observed',
      tenantId: options.global ? undefined : options.tenantId,
      baseHalfLifeDays,
    },
    options.target.clock(),
  );
}

function writeOrProbeImport(
  target: OpenImport,
  entry: MemoryEntry,
  options: ImportOptions,
): boolean {
  const { files } = target;
  if (options.dryRun) {
    const check = {
      tenantId: entry.tenantId ?? DEFAULT_TENANT_ID,
      entryId: entry.id,
      content: entry.content,
    };
    return !files.refusedAmong([check])[0];
  }
  try {
    files.writeEntry({ entry, actor: CLI_ACTOR });
  } catch (err) {
    if (err instanceof RejectedValueError) return false;
    throw err;
  }
  return true;
}
