/**
 * AT1 rejected-value tombstone — shared reject/unreject/list flow.
 * docs/plans/2026-08-15-at1-rejected-value-tombstone.md (T2, plan §4).
 *
 * The CLI (`hippo reject`/`rejections`/`unreject`) and the Context-based
 * `api.reject`/`api.unreject`/`api.listRejections` surfaces both need the
 * SAME multi-step transaction + post-commit mirror-purge flow. Extracted
 * here (leaf module) so neither duplicates it.
 *
 * Module direction: this file imports from store.ts, rejection.ts, and
 * raw-archive.ts. Nothing imports FROM this file except cli.ts and api.ts,
 * so it introduces no cycle.
 */

import { openHippoDb, closeHippoDb } from './db.js';
import { appendAuditEvent } from './audit.js';
import { archiveRawMemory } from './raw-archive.js';
import {
  initStore,
  deleteEntryCore,
  removeEntryMirrors,
  writeIndexMirror,
  buildIndexFromDb,
} from './store.js';
import {
  rejectionDigest,
  normalizeValueForRejection,
  insertRejectedValue,
  deleteRejectedValue,
  listRejectedValues,
  type RejectedValueRow,
} from './rejection.js';

export interface RejectFlowOpts {
  hippoRoot: string;
  tenantId: string;
  actor: string;
  reason: string;
  /** By-id form: reject the CURRENT content of an existing memory. */
  memoryId?: string;
  /** Pre-emptive form: reject a value not currently stored (or already gone). */
  value?: string;
}

export interface RejectFlowResult {
  digest: string;
  /** The rejected content, for the CLI's at-reject-time echo (plan §2: the
   *  tombstone itself stores no content — this is the only place it's seen
   *  again after this call returns). */
  content: string;
  /** Every live row removed this call (all tenant rows whose normalized
   *  digest matched — not just the id passed, per the K1/R7 duplicate
   *  lesson). */
  removedIds: string[];
  /** Subset of removedIds that were kind='raw' (archived, not deleted). */
  removedRawIds: string[];
}

/**
 * `hippo reject` / `api.reject` core flow. ONE connection, one transaction:
 * insert the tombstone, enumerate + remove every live tenant row whose
 * normalized digest matches (kind-aware), one aggregate `reject_value`
 * audit, COMMIT. Then post-commit (mirrors the existing purge+reaper
 * pattern verbatim from api.archiveRaw, api.ts:1913-1938): best-effort
 * mirror purge per removed id, `mirror_cleaned_at` stamps for raw ids, one
 * index mirror rewrite.
 */
export function rejectValue(opts: RejectFlowOpts): RejectFlowResult {
  if (!opts.reason.trim()) {
    throw new Error('reject requires a non-empty --reason (the tombstone stores no content; reason is its only identity).');
  }
  if (opts.memoryId === undefined && opts.value === undefined) {
    throw new Error('reject requires either a memory id or --value.');
  }
  if (opts.value !== undefined && normalizeValueForRejection(opts.value).length === 0) {
    // Direct api callers can pass strings the CLI flag parser would have
    // refused; an empty-normalized tombstone would refuse nothing meaningful
    // and pollute the listing.
    throw new Error('reject --value requires non-empty content.');
  }

  initStore(opts.hippoRoot);
  const db = openHippoDb(opts.hippoRoot);
  try {
    let content: string;
    if (opts.memoryId !== undefined) {
      const row = db
        .prepare(`SELECT content, tenant_id FROM memories WHERE id = ?`)
        .get(opts.memoryId) as { content: string; tenant_id: string } | undefined;
      if (!row || row.tenant_id !== opts.tenantId) {
        throw new Error(`memory not found: ${opts.memoryId}`);
      }
      content = row.content;
    } else {
      content = opts.value!;
    }

    const digest = rejectionDigest(content);
    const now = new Date().toISOString();
    const removedIds: string[] = [];
    const removedRawIds: string[] = [];

    db.exec('BEGIN');
    try {
      insertRejectedValue(db, {
        tenantId: opts.tenantId,
        digest,
        reason: opts.reason,
        rejectedBy: opts.actor,
        rejectedAt: now,
        sourceMemoryId: opts.memoryId ?? null,
        normalizedChars: normalizeValueForRejection(content).length,
      });

      // O(N) scan over the tenant's rows (plan §4): human-triggered command
      // on ~1-5k-row stores — acceptable, documented. A digest column on
      // memories is the escape if stores grow 100x; not needed now.
      const rows = db
        .prepare(`SELECT id, kind, content FROM memories WHERE tenant_id = ?`)
        .all(opts.tenantId) as Array<{ id: string; kind: string; content: string }>;
      for (const row of rows) {
        if (rejectionDigest(row.content) !== digest) continue;
        if (row.kind === 'raw') {
          // Append-only trigger respected — archiveRawMemory is the only
          // legitimate removal path for kind='raw', and its inner SAVEPOINT
          // composes safely inside this BEGIN/COMMIT.
          archiveRawMemory(db, row.id, { reason: opts.reason, who: opts.actor });
          removedRawIds.push(row.id);
        } else {
          // suppressForgetAudit: the aggregate reject_value row below is the
          // trail for these removals, not N individual forget rows (plan
          // §4, round-3 advisory 2 — mirrors api.ts:1873-1877).
          deleteEntryCore(db, row.id, { actor: opts.actor, suppressForgetAudit: true });
        }
        removedIds.push(row.id);
      }

      try {
        appendAuditEvent(db, {
          tenantId: opts.tenantId,
          actor: opts.actor,
          op: 'reject_value',
          targetId: opts.memoryId,
          metadata: { digest, removedIds, count: removedIds.length },
        });
      } catch {
        // Best-effort — mirrors store.ts's private audit() semantics. This
        // runs INSIDE the still-open transaction (COMMIT is the next
        // statement): a swallowed audit failure lets the tombstone +
        // removals commit without the trail row, rather than rolling the
        // whole reject back over bookkeeping.
      }

      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // already rolled back
      }
      throw err;
    }

    // Post-commit, db handle still open (same pattern as api.archiveRaw):
    // best-effort mirror purge per removed id, reaper-backstop stamp for
    // raw ids, one index mirror rewrite.
    for (const id of removedIds) {
      let mirrorOk = false;
      try {
        removeEntryMirrors(opts.hippoRoot, id);
        mirrorOk = true;
      } catch (mirrorErr) {
        console.error(
          `hippo reject: mirror cleanup failed for ${id} (will retry via reaper on next open): ${
            mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr)
          }`,
        );
      }
      if (mirrorOk && removedRawIds.includes(id)) {
        db.prepare(`UPDATE raw_archive SET mirror_cleaned_at = ? WHERE memory_id = ?`).run(
          new Date().toISOString(),
          id,
        );
      }
    }
    if (removedIds.length > 0) {
      writeIndexMirror(opts.hippoRoot, buildIndexFromDb(db));
    }

    return { digest, content, removedIds, removedRawIds };
  } finally {
    closeHippoDb(db);
  }
}

export type UnrejectOutcome =
  | { status: 'ok'; digest: string; reason: string | null }
  | { status: 'not_found' }
  | { status: 'ambiguous'; candidates: RejectedValueRow[] };

/**
 * `hippo unreject` / `api.unreject` — resolve a unique tombstone by digest
 * (or prefix), delete it, audit `unreject_value`. The only v1 escape hatch
 * (plan §4): no per-write force flag.
 */
export function unrejectValue(
  hippoRoot: string,
  tenantId: string,
  digestOrPrefix: string,
  actor: string,
): UnrejectOutcome {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const all = listRejectedValues(db, tenantId);
    const matches = all.filter((r) => r.digest.startsWith(digestOrPrefix));
    if (matches.length === 0) return { status: 'not_found' };
    if (matches.length > 1) return { status: 'ambiguous', candidates: matches };

    const target = matches[0]!;
    deleteRejectedValue(db, tenantId, target.digest);
    try {
      appendAuditEvent(db, {
        tenantId,
        actor,
        op: 'unreject_value',
        targetId: target.sourceMemoryId ?? undefined,
        metadata: { digest: target.digest, reason: target.reason },
      });
    } catch {
      // Best-effort, same as reject's audit call above.
    }
    return { status: 'ok', digest: target.digest, reason: target.reason };
  } finally {
    closeHippoDb(db);
  }
}

/** `hippo rejections` / `api.listRejections` — list tombstones for a tenant. */
export function listRejectionsForTenant(hippoRoot: string, tenantId: string): RejectedValueRow[] {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    return listRejectedValues(db, tenantId);
  } finally {
    closeHippoDb(db);
  }
}
