/**
 * Domain API layer for Hippo.
 *
 * Pure functions taking a Context (hippoRoot + tenantId + actor) plus
 * operation options. Both the CLI (direct mode) and the HTTP server
 * (`hippo serve`, A1) call into this module so the business logic lives
 * in exactly one place.
 */

import { openHippoDb, closeHippoDb } from './db.js';
import { writeEntry } from './store.js';
import { createMemory, type MemoryKind } from './memory.js';
import { appendAuditEvent } from './audit.js';

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
