/** Memory importers for Hippo.
 *  Imports memories from ChatGPT, Claude, Cursor, generic files, and structured markdown. */

import { DEFAULT_TENANT_ID } from '../util/env.js';
import { createMemory, Layer, MemoryEntry } from '../core/memory.js';
import { writeEntry } from '../store/entry-writes.js';
import { loadAllEntries } from '../store/entry-reads.js';
import { duplicateKey, storedTextKeys } from '../util/same-text.js';
import { getGlobalRoot, initGlobal } from '../sharing/global-store.js';
import { withRequestStoresSync } from '../db/request-stores.js';
import { RejectedValueError } from '../store/rejection.js';
import { rejectionGuardRefuses } from '../store/rejected-values.js';
import { loadConfig } from '../core/config.js';
import { vetSecrets } from '../util/secret-detect.js';
import { log } from '../util/log.js';

export interface ImportResult {
  total: number;     // entries found in source
  imported: number;  // actually imported (after dedup)
  skipped: number;   // skipped as duplicates or too short
  /** Entries refused by the rejection-value guard, kept apart from `skipped` (dedup) so a tombstoned value is distinguishable in summaries.
   *  Optional because `ImportResult` is exported from the package root and a required field breaks existing consumers; read sites use `?? 0`. */
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
  /** Tenant scope for the dedup read: when set and `global` is false, only this tenant's entries count.
   *  Ignored when `global: true` (host-wide); undefined means host-wide dedup. */
  tenantId?: string;
  /** K1 vault import only: logical vault name for the `vault:<name>` tag and `artifactRef` key. REQUIRED by importVault (throws if missing or blank),
   *  because it keys the destructive deletion sync and two vaults sharing a basename would clobber each other. LIKE-escaped by the loader. */
  name?: string;
  /** K1 vault import only. Memory scope stamped on every imported note. Defaults
   *  to null (unscoped) when unset. */
  scope?: string;
}

/** Given an array of raw text chunks, deduplicate against existing memories,
 *  create MemoryEntry objects, write them (unless dry-run), and return a result. */
export function importEntries(
  chunks: string[],
  source: string,
  tags: string[],
  options: ImportOptions
): ImportResult {
  const { targetRoot, keys } = openImportTarget(options);
  const allTags = [...new Set([...tags, ...(options.extraTags ?? [])])];
  const baseHalfLifeDays = loadConfig(targetRoot).defaultHalfLifeDays;

  let total = 0;
  let imported = 0;
  let skipped = 0;
  let rejected = 0;
  let redacted = 0;
  const entries: MemoryEntry[] = [];

  // One scope, so the store opens once however many chunks land: each write, or a dry run's guard probe, shares its handle.
  return withRequestStoresSync(() => {
    for (const raw of chunks) {
      const { chunk, wasRedacted } = prepareImportChunk(raw, allTags);

      const skip = skipReason(chunk, keys);
      if (skip !== 'too-short') total++;
      if (skip !== null) {
        skipped++;
        continue;
      }

      const entry = createImportEntry(chunk, source, allTags, options, baseHalfLifeDays);
      if (!writeOrProbeImport(targetRoot, entry, options)) {
        rejected++;
        continue;
      }
      // Add to existing so subsequent chunks dedup against freshly imported ones
      if (!options.dryRun) keys.add(duplicateKey(chunk));

      entries.push(entry);
      imported++;
      if (wasRedacted) redacted++;
    }

    return { total, imported, skipped, rejected, redacted, entries };
  });
}

/** The store the import writes to, made ready, with the text keys it already holds. */
function openImportTarget(options: ImportOptions) {
  const targetRoot = options.global ? getGlobalRoot() : options.hippoRoot;

  // Ensure store is ready
  if (options.global) {
    initGlobal();
  }

  const keys = storedTextKeys(loadAllEntries(
    targetRoot,
    options.global ? undefined : options.tenantId,
  ));
  return { targetRoot, keys };
}

function skipReason(chunk: string, keys: ReturnType<typeof storedTextKeys>): 'too-short' | 'duplicate' | null {
  // Skip empty or too-short chunks
  if (!chunk || chunk.length < 10) return 'too-short';
  // Dedup check: skip only when the same text is already stored
  if (keys.has(duplicateKey(chunk))) return 'duplicate';
  return null;
}

/** The secret-vetted chunk capped at 1000 chars, and whether vetting changed it. */
function prepareImportChunk(raw: string, allTags: string[]) {
  const original = raw.trim();
  const trimmed = vetSecrets(original, allTags, true).content;
  const wasRedacted = trimmed !== original;
  if (trimmed.length > 1000) {
    log.warn(`imported memory truncated from ${trimmed.length} to 1000 chars`);
  }
  return { chunk: trimmed.slice(0, 1000), wasRedacted };
}

function createImportEntry(
  chunk: string,
  source: string,
  allTags: string[],
  options: ImportOptions,
  baseHalfLifeDays: number,
): MemoryEntry {
  // kind defaults to 'distilled': these exports are curated user pastes, not raw transcripts from a system of record (see MEMORY_ENVELOPE.md).
  // The write must use the same tenant as the scoped dedup read above: global=true writes host-wide, global=false writes to options.tenantId.
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
function writeOrProbeImport(targetRoot: string, entry: MemoryEntry, options: ImportOptions): boolean {
  if (options.dryRun) return !rejectionGuardRefuses(targetRoot, entry.tenantId ?? DEFAULT_TENANT_ID, entry.id, entry.content);
  // A rejection refuses one chunk, not the whole import, so siblings still land.
  try {
    writeEntry(targetRoot, entry);
  } catch (err) {
    if (err instanceof RejectedValueError) return false;
    throw err;
  }
  return true;
}

