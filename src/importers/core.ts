/** Memory importers for Hippo.
 *  Imports memories from ChatGPT, Claude, Cursor, generic files, and structured markdown. */

import { ALL_TENANTS, DEFAULT_TENANT_ID, type TenantId } from '../util/tenant.js';
import { createMemory, Layer, MemoryEntry } from '../core/memory.js';
import { duplicateKey, heldTextKeys } from '../util/same-text.js';
import { getGlobalRoot } from '../sharing/global-store.js';
import { withRequestStoresSync } from '../db/request-stores.js';
import { RejectedValueError } from '../core/api-errors.js';
import type { LocalFiles, Sync } from '../store/port.js';
import type { Rejections } from '../store/port/rejections.js';
import { loadConfig } from '../core/config.js';
import { vetSecrets } from '../util/secret-detect.js';
import { log } from '../util/log.js';

/** Below this length a chunk holds nothing worth recalling. */
const MIN_IMPORT_CHARS = 10;
/** An imported memory keeps at most this much of its chunk; the rest is cut with a warning. */
const MAX_IMPORT_CHARS = 1000;

export interface ImportResult {
  total: number; // entries found in source
  imported: number; // actually imported (after dedup)
  skipped: number; // skipped as duplicates or too short
  /**
   * Entries refused by the rejection-value guard, kept apart from `skipped` (dedup) so a tombstoned value is
   * distinguishable in summaries.
   * Optional because `ImportResult` is exported from the package root and a required field breaks existing consumers;
   * read sites use `?? 0`.
   */
  rejected?: number;
  /** K1 vault import: rows archived this run (changed + source-deleted). In a
   *  dryRun this is the would-be count (a true deletion-sync preview). */
  archived?: number;
  /** Entries stored with secret-shaped text redacted; optional for the same published-surface reason as `rejected`. */
  redacted?: number;
  entries: MemoryEntry[];
}

export interface ImportOptions {
  dryRun?: boolean;
  global?: boolean;
  extraTags?: string[];
  hippoRoot: string;
  /** The tenant written as, DEFAULT_TENANT_ID when left out: the dedup read counts only its entries, except under
   * `global`, which counts every tenant's. */
  tenantId?: string;
  /**
   * K1 vault import only: logical vault name for the `vault:<name>` tag and `artifactRef` key. REQUIRED by importVault
   * (throws if missing or blank),
   * because it keys the destructive deletion sync and two vaults sharing a basename would clobber each other.
   * LIKE-escaped by the loader.
   */
  name?: string;
  /** K1 vault import only. Memory scope stamped on every imported note. Defaults
   *  to null (unscoped) when unset. */
  scope?: string;
}

/** The folder an import writes to and its store, answered at once; a composition root builds it. */
export interface ImportTarget {
  readonly root: string;
  readonly store: { readonly localFiles: LocalFiles; readonly rejections: Sync<Rejections> };
}

/** `ImportOptions` with the store the import writes to. */
export type TargetedImport = ImportOptions & { readonly target: ImportTarget };

/** The folder an import writes to: the operator's global store under `global`, else `hippoRoot`. */
export function importRoot(options: ImportOptions): string {
  return options.global ? getGlobalRoot() : options.hippoRoot;
}

/** Given an array of raw text chunks, deduplicate against existing memories,
 *  create MemoryEntry objects, write them (unless dry-run), and return a result. */
export function importEntries(chunks: string[], source: string, tags: string[], options: TargetedImport): ImportResult {
  const target = openImportTarget(options);
  const allTags = [...new Set([...tags, ...(options.extraTags ?? [])])];
  const baseHalfLifeDays = loadConfig(target.targetRoot).defaultHalfLifeDays;

  let total = 0;
  let imported = 0;
  let skipped = 0;
  let rejected = 0;
  let redacted = 0;
  const entries: MemoryEntry[] = [];

  // One scope, so the store opens once however many chunks land: each write, or a dry run's guard probe, shares its
  // handle.
  return withRequestStoresSync(() => {
    for (const raw of chunks) {
      const { chunk, wasRedacted } = prepareImportChunk(raw);

      const skip = skipReason(chunk, target);
      if (skip !== 'too-short') total++;
      if (skip !== null) {
        skipped++;
        continue;
      }

      const entry = createImportEntry(chunk, source, allTags, options, baseHalfLifeDays);
      if (!writeOrProbeImport(target, entry, options)) {
        rejected++;
        continue;
      }
      // Add to existing so subsequent chunks dedup against freshly imported ones
      if (!options.dryRun) target.written.add(duplicateKey(chunk));

      entries.push(entry);
      imported++;
      if (wasRedacted) redacted++;
    }

    return { total, imported, skipped, rejected, redacted, entries };
  });
}

interface OpenImport {
  readonly targetRoot: string;
  readonly learning: LocalFiles['learning'];
  readonly sharing: LocalFiles['sharing'];
  /** Whose rows a chunk is checked against. */
  readonly tenantId: TenantId;
  /** Keys of the chunks this run wrote; a dry run writes none. */
  readonly written: Set<string>;
  readonly rejections: Sync<Rejections>;
}

/** The store the import writes to, made ready. */
function openImportTarget({ global, tenantId, target }: TargetedImport): OpenImport {
  const { localFiles, rejections } = target.store;
  if (global) localFiles.ensureFiles();
  const scope = global ? ALL_TENANTS : (tenantId ?? DEFAULT_TENANT_ID);
  return {
    targetRoot: target.root,
    learning: localFiles.learning,
    sharing: localFiles.sharing,
    tenantId: scope,
    written: new Set(),
    rejections,
  };
}

function skipReason(chunk: string, target: OpenImport): 'too-short' | 'duplicate' | null {
  if (!chunk || chunk.length < MIN_IMPORT_CHARS) return 'too-short';
  if (target.written.has(duplicateKey(chunk)) || storeHolds(target, chunk)) return 'duplicate';
  return null;
}

/** Only the rows holding the chunk's words can hold the chunk, so the store is asked for those alone. */
function storeHolds({ sharing, tenantId }: OpenImport, chunk: string): boolean {
  const key = duplicateKey(chunk);
  return sharing.textKeysHolding(tenantId, [chunk]).some((row) => heldTextKeys(row).includes(key));
}

/** The secret-vetted chunk capped at MAX_IMPORT_CHARS, and whether vetting changed it. */
function prepareImportChunk(raw: string) {
  const original = raw.trim();
  const trimmed = vetSecrets(original).content;
  const wasRedacted = trimmed !== original;
  if (trimmed.length > MAX_IMPORT_CHARS) {
    log.warn(`imported memory truncated from ${trimmed.length} to ${MAX_IMPORT_CHARS} chars`);
  }
  return { chunk: trimmed.slice(0, MAX_IMPORT_CHARS), wasRedacted };
}

function createImportEntry(
  chunk: string,
  source: string,
  allTags: string[],
  options: ImportOptions,
  baseHalfLifeDays: number,
): MemoryEntry {
  // kind defaults to 'distilled': these exports are curated user pastes, not raw transcripts from a system of record
  // (see MEMORY_ENVELOPE.md).
  // The write must use the same tenant as the scoped dedup read above: global=true writes host-wide, global=false
  // writes to options.tenantId.
  return createMemory(chunk, {
    layer: Layer.Episodic,
    tags: allTags,
    source,
    confidence: 'observed',
    tenantId: options.global ? undefined : options.tenantId,
    baseHalfLifeDays,
  });
}

/** Writes the entry, or on a dry run only probes the guard; false when a rejected value refuses it. */
function writeOrProbeImport(target: OpenImport, entry: MemoryEntry, options: ImportOptions): boolean {
  const { learning, rejections } = target;
  if (options.dryRun) {
    const check = { tenantId: entry.tenantId ?? DEFAULT_TENANT_ID, entryId: entry.id, content: entry.content };
    return !rejections.refusedAmong([check])[0];
  }
  // A rejection refuses one chunk, not the whole import, so siblings still land.
  try {
    learning.writeEntry(entry);
  } catch (err) {
    if (err instanceof RejectedValueError) return false;
    throw err;
  }
  return true;
}
