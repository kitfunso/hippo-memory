/**
 * Domain API layer for Hippo.
 *
 * Pure functions taking a Context (hippoRoot + tenantId + actor) plus
 * operation options. Both the CLI (direct mode) and the HTTP server
 * (`hippo serve`, A1) call into this module so the business logic lives
 * in exactly one place.
 */

import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from './db.js';
import {
  writeEntry,
  writeEntryDbOnly,
  writeEntryMirrors,
  readEntry,
  deleteEntry,
  loadSearchEntries,
  removeEntryMirrors,
} from './store.js';
import {
  createMemory,
  applyOutcome,
  type MemoryKind,
  type MemoryEntry,
  Layer,
} from './memory.js';
import {
  appendAuditEvent,
  queryAuditEvents,
  type AuditEvent,
  type AuditOp,
} from './audit.js';
import { promoteToGlobal, getGlobalRoot } from './shared.js';
import { archiveRawMemory } from './raw-archive.js';
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKeyListItem,
} from './auth.js';

export interface Context {
  hippoRoot: string;
  tenantId: string;
  /** 'cli' | 'localhost:cli' | 'api_key:<key_id>' | 'mcp' */
  actor: string;
}

export interface RememberOpts {
  content: string;
  kind?: MemoryKind;
  scope?: string;
  owner?: string;
  artifactRef?: string;
  tags?: string[];
  /**
   * Optional hook invoked inside the same transaction as the underlying
   * memories INSERT. Used by ingestion connectors (E1.3+) to stamp
   * idempotency / cursor rows atomically with the memory row, so a crash
   * mid-write cannot produce a memory without its corresponding side-effect
   * log row (or vice versa). If the callback throws, the INSERT is rolled
   * back and the error is rethrown.
   */
  afterWrite?: (db: DatabaseSyncLike, memoryId: string) => void;
}

export interface RememberResult {
  id: string;
  kind: MemoryKind;
  tenantId: string;
}

export function remember(ctx: Context, opts: RememberOpts): RememberResult {
  const entry = createMemory(opts.content, {
    kind: opts.kind ?? 'distilled',
    scope: opts.scope ?? null,
    owner: opts.owner ?? null,
    artifact_ref: opts.artifactRef ?? null,
    tags: opts.tags,
    tenantId: ctx.tenantId,
  });
  // writeEntry threads ctx.actor into its internal audit hook, so exactly
  // one 'remember' event lands in the log with the supplied actor.
  writeEntry(ctx.hippoRoot, entry, { actor: ctx.actor, afterWrite: opts.afterWrite });

  return { id: entry.id, kind: entry.kind, tenantId: ctx.tenantId };
}

// ---------------------------------------------------------------------------
// recall
// ---------------------------------------------------------------------------

export interface RecallOpts {
  query: string;
  limit?: number;
  mode?: 'bm25' | 'hybrid' | 'physics';
  /**
   * Restrict results to memories whose `scope` equals this value exactly.
   *
   * When `scope` is undefined or empty, recall applies a DEFAULT-DENY rule:
   * any memory whose scope starts with `'slack:private:'` is filtered out so
   * a frontend caller passing `undefined` cannot accidentally surface
   * private-channel content. Memories with scope=null (the common case for
   * non-Slack content) are still returned.
   */
  scope?: string;
}

export interface RecallResultItem {
  id: string;
  content: string;
  score: number;
  layer: string;
  strength: number;
}

export interface RecallResult {
  results: RecallResultItem[];
  total: number;
  tokens: number;
}

/**
 * Domain-level recall. Loads BM25-ranked candidates from SQLite scoped to
 * `ctx.tenantId`. The `mode` flag is accepted for forward compatibility (the
 * CLI exposes hybrid/physics paths) but Task 2 wires only the BM25 candidate
 * loader; later tasks can extend this to call the physics/hybrid scorer.
 */
export function recall(ctx: Context, opts: RecallOpts): RecallResult {
  const limit = opts.limit ?? 10;
  const all = loadSearchEntries(
    ctx.hippoRoot,
    opts.query,
    undefined,
    ctx.tenantId,
  );
  // Scope filtering runs AFTER the tenant filter inside loadSearchEntries, so
  // a tenant-mismatched scope cannot surface another tenant's row even when
  // both share the same scope string (e.g. 'slack:private:CSHARED').
  let entries: typeof all;
  if (opts.scope !== undefined && opts.scope !== '') {
    entries = all.filter((e) => e.scope === opts.scope);
  } else {
    // Default-deny: a no-scope caller cannot see private slack channels. This
    // is load-bearing because frontend callers will pass `undefined` and must
    // not see `slack:private:*` rows by default.
    entries = all.filter((e) => !(e.scope ?? '').startsWith('slack:private:'));
  }
  // BM25 ordering already comes from loadSearchEntries; cap to `limit`.
  // Score is a placeholder — the physics/hybrid scorers in src/search.ts
  // produce richer breakdowns and will replace this when wired up.
  const ranked = entries.slice(0, limit).map((entry, idx) => ({
    id: entry.id,
    content: entry.content,
    score: Math.max(0, 1 - idx / Math.max(1, limit)),
    layer: entry.layer,
    strength: entry.strength,
  }));
  const tokens = ranked.reduce((acc, r) => acc + Math.ceil(r.content.length / 4), 0);

  // TODO(a1-task-4): emit via the shared audit hook in store.ts so we don't
  // double-emit. Recall does not currently write through writeEntry, so no
  // duplicate exists today, but we keep the same shape for symmetry.
  const db = openHippoDb(ctx.hippoRoot);
  try {
    appendAuditEvent(db, {
      tenantId: ctx.tenantId,
      actor: ctx.actor,
      op: 'recall',
      metadata: { query: opts.query.slice(0, 200), results: ranked.length },
    });
  } finally {
    closeHippoDb(db);
  }

  return { results: ranked, total: entries.length, tokens };
}

// ---------------------------------------------------------------------------
// outcome
// ---------------------------------------------------------------------------

/**
 * Apply a positive/negative outcome to a list of recently-recalled memory ids.
 * Used by the MCP `hippo_outcome` tool. Tenant-scoped: ids that don't belong
 * to ctx.tenantId are silently skipped (matches the prior MCP semantics —
 * a stale id from another tenant doesn't crash the call). Each successful
 * outcome emits one audit_log row with op='outcome' tagged with ctx.actor.
 */
export function outcome(
  ctx: Context,
  ids: ReadonlyArray<string>,
  good: boolean,
): { applied: number } {
  let applied = 0;
  const db = openHippoDb(ctx.hippoRoot);
  try {
    for (const id of ids) {
      const entry = readEntry(ctx.hippoRoot, id, ctx.tenantId);
      if (!entry) continue;
      const updated = applyOutcome(entry, good);
      writeEntry(ctx.hippoRoot, updated, { actor: ctx.actor });
      appendAuditEvent(db, {
        tenantId: ctx.tenantId,
        actor: ctx.actor,
        op: 'outcome',
        targetId: id,
        metadata: { good },
      });
      applied++;
    }
  } finally {
    closeHippoDb(db);
  }
  return { applied };
}

// ---------------------------------------------------------------------------
// forget
// ---------------------------------------------------------------------------

/**
 * Delete a memory by id. `deleteEntry` threads ctx.actor into its internal
 * audit hook, so exactly one 'forget' event lands with the supplied actor.
 *
 * Tenant scope: deleteEntry looks up the row by id alone, so without an
 * explicit tenant guard a Bearer for tenant A could delete tenant B's row
 * by guessing or leaking the id. Pre-check the row's tenant_id and deny
 * cross-tenant access with a not-found error (no info leak about whether
 * the id exists in another tenant).
 */
export function forget(ctx: Context, id: string): { ok: true; id: string } {
  const db = openHippoDb(ctx.hippoRoot);
  try {
    const row = db
      .prepare(`SELECT tenant_id FROM memories WHERE id = ?`)
      .get(id) as { tenant_id?: string } | undefined;
    if (!row || row.tenant_id !== ctx.tenantId) {
      throw new Error(`memory not found: ${id}`);
    }
  } finally {
    closeHippoDb(db);
  }
  const removed = deleteEntry(ctx.hippoRoot, id, { actor: ctx.actor });
  if (!removed) {
    throw new Error(`memory not found: ${id}`);
  }
  return { ok: true, id };
}

// ---------------------------------------------------------------------------
// promote
// ---------------------------------------------------------------------------

/**
 * Copy a local memory into the global store. Mirrors `cmdPromote` in cli.ts:
 * the `writeEntry` inside `promoteToGlobal` emits a 'remember' on the global
 * db; we add a 'promote' audit event on the global db so the user-facing
 * intent stays distinct from the underlying upsert.
 *
 * Note: `promoteToGlobal` does not currently take a tenantId override — it
 * reads the entry from the local root via `readEntry` (no tenant filter) and
 * preserves the entry's existing tenantId on the global side. Task 4 may
 * tighten this once writeEntry/readEntry thread tenant context.
 */
export function promote(
  ctx: Context,
  id: string,
): { ok: true; sourceId: string; globalId: string } {
  // Tenant scope: promoteToGlobal reads the entry from the local root via
  // readEntry without a tenant filter, so a Bearer for tenant A could
  // promote tenant B's row by guessing or leaking the id. Pre-check the
  // row's tenant_id and deny cross-tenant access with the same not-found
  // wording archiveRaw uses (no info leak about whether the id exists in
  // another tenant).
  const ownerDb = openHippoDb(ctx.hippoRoot);
  try {
    const row = ownerDb
      .prepare(`SELECT tenant_id FROM memories WHERE id = ?`)
      .get(id) as { tenant_id?: string } | undefined;
    if (!row || row.tenant_id !== ctx.tenantId) {
      throw new Error(`memory not found: ${id}`);
    }
  } finally {
    closeHippoDb(ownerDb);
  }

  // promoteToGlobal threads ctx.actor into the writeEntry call on the global
  // db, which emits a 'remember' audit row. We then add the user-facing
  // 'promote' event on the global db so the audit trail keeps the intent
  // distinct from the underlying upsert.
  const globalEntry = promoteToGlobal(ctx.hippoRoot, id, { actor: ctx.actor });

  const db = openHippoDb(getGlobalRoot());
  try {
    appendAuditEvent(db, {
      tenantId: ctx.tenantId,
      actor: ctx.actor,
      op: 'promote',
      targetId: globalEntry.id,
      metadata: { sourceId: id },
    });
  } finally {
    closeHippoDb(db);
  }

  return { ok: true, sourceId: id, globalId: globalEntry.id };
}

// ---------------------------------------------------------------------------
// supersede
// ---------------------------------------------------------------------------

/**
 * Replace an old memory with new content, chaining old.superseded_by = new.id.
 * Mirrors `cmdSupersede` in cli.ts (without flag-driven layer/tag/pin overrides
 * — A1 keeps the API minimal; the CLI handler will continue to handle those
 * flags and pass the resolved values once Task 4 lands).
 */
export function supersede(
  ctx: Context,
  oldId: string,
  newContent: string,
): { ok: true; oldId: string; newId: string } {
  // Read old (tenant-scoped). readEntry filters by tenantId, so a Bearer for
  // tenant A on tenant B's id throws "Memory not found" here without any
  // info leak.
  const old: MemoryEntry | null = readEntry(ctx.hippoRoot, oldId, ctx.tenantId);
  if (!old) {
    throw new Error(`Memory not found: ${oldId}`);
  }
  // Guard: not already superseded. The CAS UPDATE below race-safely closes
  // the window between this read and the write; this check just produces a
  // clearer error in the common single-writer case.
  if (old.superseded_by) {
    throw new Error(
      `Memory ${oldId} is already superseded by ${old.superseded_by}. Supersede that one instead.`,
    );
  }

  const newEntry = createMemory(newContent, {
    layer: old.layer ?? Layer.Episodic,
    tags: [...old.tags],
    pinned: old.pinned,
    source: old.source,
    confidence: 'verified',
    tenantId: ctx.tenantId,
  });

  // Race-safe transition: open a fresh db handle, BEGIN IMMEDIATE, run all
  // three steps (CAS on old + writeEntryDbOnly(new) + supersede audit row)
  // inside the same transaction. Two concurrent supersedes: exactly one CAS
  // wins (changes=1), the other gets changes=0 and throws CONFLICT. No
  // dangling-pointer window: the new memory's row commits atomically with
  // the old.superseded_by pointer.
  const db = openHippoDb(ctx.hippoRoot);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      // 1. CAS update: only succeed if old.superseded_by IS NULL AND the
      //    row still belongs to ctx.tenantId. Tenant filter is belt-and-
      //    braces with the readEntry above — it costs nothing and closes
      //    a hypothetical window where ownership changes between read and
      //    update.
      const result = db.prepare(`
        UPDATE memories
        SET superseded_by = ?
        WHERE id = ? AND tenant_id = ? AND superseded_by IS NULL
      `).run(newEntry.id, oldId, ctx.tenantId);
      if ((result.changes ?? 0) === 0) {
        db.exec('ROLLBACK');
        throw new Error(`Memory ${oldId} already superseded by another writer`);
      }
      // 2. Write new memory inside same tx via writeEntryDbOnly (DB-only
      //    path). This emits its OWN 'remember' audit row for the new
      //    memory inside the SAVEPOINT — atomic with the row INSERT.
      writeEntryDbOnly(db, newEntry, { actor: ctx.actor });
      // 3. User-facing 'supersede' audit row inside the same tx so the
      //    chain pointer + audit trail commit atomically.
      appendAuditEvent(db, {
        tenantId: ctx.tenantId,
        actor: ctx.actor,
        op: 'supersede',
        targetId: oldId,
        metadata: { newId: newEntry.id },
      });
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
    // Mirrors after COMMIT, while the db handle is still open. Same
    // invariant as the original writeEntry: a mirror failure leaves disk
    // MISSING the markdown for the new memory (self-heals on next backfill
    // via writeIndexMirror reading the DB) but DOES NOT desync the DB or
    // roll back the supersede. Logged + swallowed, non-fatal.
    try {
      writeEntryMirrors(ctx.hippoRoot, db, newEntry);
    } catch (mirrorErr) {
      console.error(
        'supersede: mirror write failed (non-fatal, will self-heal):',
        mirrorErr,
      );
    }
  } finally {
    closeHippoDb(db);
  }

  return { ok: true, oldId, newId: newEntry.id };
}

// ---------------------------------------------------------------------------
// archive_raw
// ---------------------------------------------------------------------------

/**
 * Archive a kind='raw' memory: snapshot into raw_archive, mark archived, delete.
 *
 * `archiveRawMemory` audits the operation internally (op='archive_raw') using the
 * row's own tenant_id. We DO NOT emit a second audit event here to avoid double-
 * emitting the archive_raw op (unlike Task 1 remember/forget where the underlying
 * helpers hardcode actor='cli'). Instead we pass `ctx.actor` through as `who`,
 * and raw-archive.ts uses that for the audit row.
 */
export function archiveRaw(
  ctx: Context,
  id: string,
  reason: string,
): { ok: true; archivedAt: string } {
  const db = openHippoDb(ctx.hippoRoot);
  try {
    // Tenant scope: archiveRawMemory looks up the row by id alone, so a
    // Bearer for tenant A could archive tenant B's raw row without this
    // pre-check. Deny cross-tenant access with the same not-found message
    // archiveRawMemory itself would throw on a missing row, so we don't
    // leak whether the id exists in another tenant.
    const row = db
      .prepare(`SELECT tenant_id FROM memories WHERE id = ?`)
      .get(id) as { tenant_id?: string } | undefined;
    if (!row || row.tenant_id !== ctx.tenantId) {
      throw new Error(`memory not found: ${id}`);
    }
    archiveRawMemory(db, id, { reason, who: ctx.actor });
  } finally {
    closeHippoDb(db);
  }
  // archiveRawMemory deletes the memories row but leaves any legacy markdown
  // mirror in <root>/{buffer,episodic,semantic}/<id>.md untouched. If we left
  // the mirror in place, a subsequent initStore() on an empty memories table
  // would silently re-import the row via bootstrapLegacyStore — defeating the
  // archive (and the GDPR right-to-be-forgotten promise on raw rows). Mirror
  // forget() at src/store.ts:1046, which uses the same removeEntryMirrors call.
  removeEntryMirrors(ctx.hippoRoot, id);
  // archiveRawMemory does not return the archive_at timestamp it wrote. We
  // emit a fresh ISO timestamp here for the API response. Within a millisecond
  // of the actual write, fine for a server response shape.
  return { ok: true, archivedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// auth: create / list / revoke
// ---------------------------------------------------------------------------

export interface AuthCreateOpts {
  label?: string;
}

export interface AuthCreateResult {
  keyId: string;
  plaintext: string;
  tenantId: string;
}

/**
 * Mint a new API key. The new key is ALWAYS bound to `ctx.tenantId`. Callers
 * cannot override the tenant via the opts bag — a previous `tenantId` field
 * was removed because the HTTP layer would happily forward `body.tenantId`,
 * letting tenant A mint a key for tenant B. The HTTP route handler at
 * `src/server.ts` POST /v1/auth/keys mirrors this: it ignores any body
 * `tenantId` and uses the resolved Bearer's tenant exclusively.
 *
 * Per A5 v2 follow-ups (TODOS.md), `auth_create` is currently unaudited —
 * we intentionally match that behavior here for consistency. When A5 v2
 * lands and adds the audit op, this function should mirror the cli handler.
 */
export function authCreate(ctx: Context, opts: AuthCreateOpts): AuthCreateResult {
  const db = openHippoDb(ctx.hippoRoot);
  try {
    const result = createApiKey(db, { tenantId: ctx.tenantId, label: opts.label });
    return { keyId: result.keyId, plaintext: result.plaintext, tenantId: ctx.tenantId };
  } finally {
    closeHippoDb(db);
  }
}

/**
 * List API keys visible to the calling tenant.
 *
 * Divergence from `cmdAuthList` in src/cli.ts: the CLI today returns ALL keys
 * regardless of tenant (single-tenant deployments). The API surface is tenant-
 * scoped because future multi-tenant deployments will share a hippoRoot, and
 * tenant A must not see tenant B's keys. Read-only — no audit emit (matches A5).
 */
export function authList(
  ctx: Context,
  opts: { active: boolean },
): ApiKeyListItem[] {
  const db = openHippoDb(ctx.hippoRoot);
  try {
    const all = listApiKeys(db, opts);
    return all.filter((k) => k.tenantId === ctx.tenantId);
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Revoke an API key.
 *
 * Security: the key must belong to `ctx.tenantId`. Cross-tenant revoke is
 * rejected with the same "not found" message used for missing keys, so that a
 * caller cannot probe which key_ids exist on other tenants.
 *
 * Audit: emits 'auth_revoke' with `tenantId` set to the KEY ROW's tenant_id
 * (M1 fix from A5 review, mirrors src/cli.ts:cmdAuthRevoke). Skipped on no-op
 * revoke (already revoked) so re-running doesn't pad the audit log.
 */
export function authRevoke(
  ctx: Context,
  keyId: string,
): { ok: true; revokedAt: string } {
  const db = openHippoDb(ctx.hippoRoot);
  try {
    const row = db
      .prepare(`SELECT key_id, tenant_id, revoked_at FROM api_keys WHERE key_id = ?`)
      .get(keyId) as
      | { key_id: string; tenant_id: string; revoked_at: string | null }
      | undefined;
    if (!row) {
      throw new Error(`Unknown key_id: ${keyId}`);
    }
    // Cross-tenant access denied: same message as missing key, no info leak.
    if (row.tenant_id !== ctx.tenantId) {
      throw new Error(`Unknown key_id: ${keyId}`);
    }

    let revokedAt: string;
    let alreadyRevoked = false;
    if (row.revoked_at) {
      alreadyRevoked = true;
      revokedAt = row.revoked_at;
    } else {
      revokeApiKey(db, keyId);
      const updated = db
        .prepare(`SELECT revoked_at FROM api_keys WHERE key_id = ?`)
        .get(keyId) as { revoked_at: string | null } | undefined;
      revokedAt = updated?.revoked_at ?? new Date().toISOString();
    }

    if (!alreadyRevoked) {
      try {
        appendAuditEvent(db, {
          tenantId: row.tenant_id, // M1: KEY's tenant, not ctx.tenantId.
          actor: ctx.actor,
          op: 'auth_revoke',
          targetId: keyId,
        });
      } catch {
        // Audit must not crash a successful revoke.
      }
    }

    return { ok: true, revokedAt };
  } finally {
    closeHippoDb(db);
  }
}

// ---------------------------------------------------------------------------
// audit: list
// ---------------------------------------------------------------------------

export interface AuditListOpts {
  op?: AuditOp;
  /** ISO timestamp lower bound. */
  since?: string;
  limit?: number;
}

/**
 * Read audit events scoped to `ctx.tenantId`. Read-only — no audit emit (matches
 * A5: cmdAuditList does not record a 'recall'-style read event).
 */
export function auditList(ctx: Context, opts: AuditListOpts): AuditEvent[] {
  const db = openHippoDb(ctx.hippoRoot);
  try {
    return queryAuditEvents(db, {
      tenantId: ctx.tenantId,
      op: opts.op,
      since: opts.since,
      limit: opts.limit,
    });
  } finally {
    closeHippoDb(db);
  }
}
