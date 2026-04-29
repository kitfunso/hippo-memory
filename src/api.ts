/**
 * Domain API layer for Hippo.
 *
 * Pure functions taking a Context (hippoRoot + tenantId + actor) plus
 * operation options. Both the CLI (direct mode) and the HTTP server
 * (`hippo serve`, A1) call into this module so the business logic lives
 * in exactly one place.
 */

import { openHippoDb, closeHippoDb } from './db.js';
import {
  writeEntry,
  readEntry,
  deleteEntry,
  loadSearchEntries,
} from './store.js';
import {
  createMemory,
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
  writeEntry(ctx.hippoRoot, entry, { actor: ctx.actor });

  return { id: entry.id, kind: entry.kind, tenantId: ctx.tenantId };
}

// ---------------------------------------------------------------------------
// recall
// ---------------------------------------------------------------------------

export interface RecallOpts {
  query: string;
  limit?: number;
  mode?: 'bm25' | 'hybrid' | 'physics';
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
  const entries = loadSearchEntries(
    ctx.hippoRoot,
    opts.query,
    undefined,
    ctx.tenantId,
  );
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
// forget
// ---------------------------------------------------------------------------

/**
 * Delete a memory by id. `deleteEntry` threads ctx.actor into its internal
 * audit hook, so exactly one 'forget' event lands with the supplied actor.
 */
export function forget(ctx: Context, id: string): { ok: true; id: string } {
  const removed = deleteEntry(ctx.hippoRoot, id, { actor: ctx.actor });
  if (!removed) {
    throw new Error(`Memory not found: ${id}`);
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
  const old: MemoryEntry | null = readEntry(ctx.hippoRoot, oldId, ctx.tenantId);
  if (!old) {
    throw new Error(`Memory not found: ${oldId}`);
  }
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
  old.superseded_by = newEntry.id;
  writeEntry(ctx.hippoRoot, old, { actor: ctx.actor });
  writeEntry(ctx.hippoRoot, newEntry, { actor: ctx.actor });

  // The two writeEntry calls above emit 'remember' audit rows; the 'supersede'
  // event below carries the user-facing intent and the chained newId.
  const db = openHippoDb(ctx.hippoRoot);
  try {
    appendAuditEvent(db, {
      tenantId: ctx.tenantId,
      actor: ctx.actor,
      op: 'supersede',
      targetId: oldId,
      metadata: { newId: newEntry.id },
    });
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
    archiveRawMemory(db, id, { reason, who: ctx.actor });
  } finally {
    closeHippoDb(db);
  }
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
  /** Override the calling tenant (e.g. admin minting a key for tenant B). */
  tenantId?: string;
}

export interface AuthCreateResult {
  keyId: string;
  plaintext: string;
  tenantId: string;
}

/**
 * Mint a new API key. Per A5 v2 follow-ups (TODOS.md), `auth_create` is currently
 * unaudited — we intentionally match that behavior here for consistency. When A5
 * v2 lands and adds the audit op, this function should mirror the cli handler.
 */
export function authCreate(ctx: Context, opts: AuthCreateOpts): AuthCreateResult {
  const tenantId = opts.tenantId ?? ctx.tenantId;
  const db = openHippoDb(ctx.hippoRoot);
  try {
    const result = createApiKey(db, { tenantId, label: opts.label });
    return { keyId: result.keyId, plaintext: result.plaintext, tenantId };
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
