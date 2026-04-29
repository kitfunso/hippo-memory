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
import { appendAuditEvent } from './audit.js';
import { promoteToGlobal, getGlobalRoot } from './shared.js';

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
  writeEntry(ctx.hippoRoot, entry);

  // TODO(a1-task-4): writeEntry already emits an audit event with actor='cli'
  // via its internal hook (see src/store.ts:31 audit()). We append a second
  // audit event here so the supplied ctx.actor lands in the log, which is
  // what HTTP / api_key callers need. This is an intentional duplicate emit
  // pending Task 4, which threads `actor` into writeEntry and dedupes.
  const db = openHippoDb(ctx.hippoRoot);
  try {
    appendAuditEvent(db, {
      tenantId: ctx.tenantId,
      actor: ctx.actor,
      op: 'remember',
      targetId: entry.id,
      metadata: { kind: entry.kind, scope: entry.scope ?? null },
    });
  } finally {
    closeHippoDb(db);
  }

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
 * Delete a memory by id. The underlying `deleteEntry` already emits an audit
 * event with actor='cli'; we append a second event with `ctx.actor` so HTTP /
 * api_key callers land in the audit log. Task 4 will dedupe by threading the
 * actor through deleteEntry.
 */
export function forget(ctx: Context, id: string): { ok: true; id: string } {
  const removed = deleteEntry(ctx.hippoRoot, id);
  if (!removed) {
    throw new Error(`Memory not found: ${id}`);
  }

  // TODO(a1-task-4): deleteEntry's internal audit hook hardcodes actor='cli'.
  // We append a second event with ctx.actor so the supplied actor lands in
  // the log. Task 4 will thread `actor` through deleteEntry and dedupe.
  const db = openHippoDb(ctx.hippoRoot);
  try {
    appendAuditEvent(db, {
      tenantId: ctx.tenantId,
      actor: ctx.actor,
      op: 'forget',
      targetId: id,
    });
  } finally {
    closeHippoDb(db);
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
  const globalEntry = promoteToGlobal(ctx.hippoRoot, id);

  // Audit on the global store, since that's where the promoted memory now
  // lives. Mirrors cmdPromote's emitCliAudit(getGlobalRoot(), ...).
  // TODO(a1-task-4): collapse with writeEntry's audit hook.
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
  writeEntry(ctx.hippoRoot, old);
  writeEntry(ctx.hippoRoot, newEntry);

  // TODO(a1-task-4): writeEntry's audit hook emits 'remember' with actor='cli'
  // for both writes above; the 'supersede' event below carries ctx.actor and is
  // the user-facing intent. Task 4 will thread actor and unify.
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
