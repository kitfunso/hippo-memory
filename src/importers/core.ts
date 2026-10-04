/**
 * Memory importers for Hippo.
 * Imports memories from ChatGPT, Claude, Cursor, generic files, and structured markdown.
 */

import { createMemory, Layer, MemoryEntry } from '../memory.js';
import { writeEntry } from '../store/entry-writes.js';
import { loadAllEntries } from '../store/entry-reads.js';
import { duplicateKey, storedTextKeys } from '../same-text.js';
import { getGlobalRoot, initGlobal } from '../shared.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../db.js';
import { RejectedValueError, checkRejectionGuard } from '../rejection.js';
import { loadConfig } from '../config.js';
import { vetSecrets } from '../secret-detect.js';
import { log } from '../log.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImportResult {
  total: number;     // entries found in source
  imported: number;  // actually imported (after dedup)
  skipped: number;   // skipped as duplicates or too short
  /** AT1: refused by the rejection-value guard — kept distinct from
   *  `skipped` (dedup) so a tombstoned value is distinguishable from a
   *  plain duplicate in import summaries (plan §3 containment, round-2 low).
   *  AT1 P2 fix (codex, published-surface compat): optional, not required —
   *  `ImportResult` is re-exported from the package root (index.ts), and a
   *  required field breaks any existing consumer constructing the pre-AT1
   *  shape. Every producer in this file still always sets a real number;
   *  `?? 0` at read sites (this file's own accumulation, cli.ts's summary
   *  prints) tolerates a caller-supplied object that omits it. */
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
  /**
   * L9: tenant scope for the dedup read. When provided AND `global` is
   * false, the dedup check only considers this tenant's existing entries.
   * Ignored when `global: true` (global writes are host-wide by definition).
   * Undefined preserves pre-1.12.1 host-wide dedup behaviour.
   */
  tenantId?: string;
  /**
   * K1 vault import only. Logical vault name used in the `vault:<name>` tag and
   * the `artifactRef='vault:<name>:<relpath>'` key. REQUIRED by importVault: it
   * is the identity key for the destructive source-deletion sync, so it must be
   * set explicitly rather than inferred from the folder basename (two vaults
   * sharing a basename would collide and clobber each other). importVault throws
   * if it is missing or blank. Optional in this shared type only because the
   * other importers ignore it. Operator-supplied, so the loader query LIKE-escapes
   * it (see `escapeLike` below).
   */
  name?: string;
  /**
   * K1 vault import only. Memory scope stamped on every imported note. Defaults
   * to null (unscoped) when unset.
   */
  scope?: string;
}

// ---------------------------------------------------------------------------
// Shared core: dedup + write
// ---------------------------------------------------------------------------

/**
 * Given an array of raw text chunks, deduplicate against existing memories,
 * create MemoryEntry objects, write them (unless dry-run), and return a result.
 */
export function importEntries(
  chunks: string[],
  source: string,
  tags: string[],
  options: ImportOptions
): ImportResult {
  const targetRoot = options.global ? getGlobalRoot() : options.hippoRoot;

  // Ensure store is ready
  if (options.global) {
    initGlobal();
  }

  const keys = storedTextKeys(loadAllEntries(
    targetRoot,
    options.global ? undefined : options.tenantId,
  ));
  const allTags = [...new Set([...tags, ...(options.extraTags ?? [])])];
  const baseHalfLifeDays = loadConfig(targetRoot).defaultHalfLifeDays;

  let total = 0;
  let imported = 0;
  let skipped = 0;
  let rejected = 0;
  let redacted = 0;
  const entries: MemoryEntry[] = [];

  // AT1 P2 fix: a dry-run preview never called writeEntry, so it never
  // checked tombstones either — every non-duplicate chunk counted as
  // `imported` even when a real run would refuse it, making the preview's
  // `rejected` count silently 0. Probe (read-only) via the same guard
  // writeEntry uses internally, without ever writing.
  const dryRunDb = options.dryRun ? openHippoDb(targetRoot) : null;
  try {
    for (const raw of chunks) {
      const { chunk, wasRedacted } = prepareImportChunk(raw, allTags);

      // Skip empty or too-short chunks
      if (!chunk || chunk.length < 10) {
        skipped++;
        continue;
      }

      total++;

      // Dedup check: skip only when the same text is already stored
      if (keys.has(duplicateKey(chunk))) {
        skipped++;
        continue;
      }

      const entry = createImportEntry(chunk, source, allTags, options, baseHalfLifeDays);
      if (!writeOrProbeImport(targetRoot, entry, options, dryRunDb)) {
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
  } finally {
    if (dryRunDb) closeHippoDb(dryRunDb);
  }
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
  // A3: kind defaults to 'distilled'. ChatGPT/Claude/Cursor exports are curated
  // user pastes, not raw transcripts from a system of record, so distilled is
  // correct here. E1.3 (Slack ingestion) shipped 2026-04-29 in src/connectors/slack/
  // and sets kind: 'raw' + routes deletions through archiveRawMemory() — these
  // importers stay 'distilled' per the original reasoning. See MEMORY_ENVELOPE.md.
  // L9: the dedup read above is scoped by options.tenantId — the WRITE
  // must match, or scoped-dedup-passes-then-default-tenant-write breaks
  // the per-tenant contract. Mirror the dedup-read guard: global=true
  // → host-wide write to global store (tenantId irrelevant, createMemory
  // defaults to 'default'). global=false → write to the same tenant as
  // the dedup read.
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
function writeOrProbeImport(
  targetRoot: string,
  entry: MemoryEntry,
  options: ImportOptions,
  dryRunDb: DatabaseSyncLike | null,
): boolean {
  if (options.dryRun) {
    if (dryRunDb) {
      try {
        checkRejectionGuard(dryRunDb, entry.tenantId ?? 'default', entry.id, entry.content);
      } catch (err) {
        if (err instanceof RejectedValueError) return false;
        throw err;
      }
    }
    return true;
  }
  // AT1 (plan §3 containment): a rejection refuses one CHUNK, not the
  // whole import batch. Caught per-item so siblings still land.
  try {
    writeEntry(targetRoot, entry);
  } catch (err) {
    if (err instanceof RejectedValueError) return false;
    throw err;
  }
  return true;
}

// ---------------------------------------------------------------------------
// ChatGPT importer
// ---------------------------------------------------------------------------

/** The full value space `JSON.parse` can produce. Boundary-guard functions in
 *  this file accept `JsonValue` (never `unknown`) so a value's origin as
 *  unparsed external JSON stays visible in its type, then narrow it via the
 *  `isJson*` predicates below. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export function isJsonString(x: JsonValue): x is string {
  return typeof x === 'string';
}

export function isJsonPlainObject(x: JsonValue): x is { [key: string]: JsonValue } {
  return x !== null && !Array.isArray(x) && typeof x === 'object';
}
