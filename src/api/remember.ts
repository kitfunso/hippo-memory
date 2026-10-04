// Write path: remember stores one memory after secret vetting and, for untrusted content, the instruction check.

import type { DatabaseSyncLike } from '../db.js';
import { writeEntry } from '../store/entry-writes.js';
import { detectInstruction } from '../instruction-detect.js';
import { quarantineScopeFor, recordQuarantine } from '../quarantine.js';
import { createMemory, type MemoryKind } from '../memory.js';
import { loadConfig } from '../config.js';
import { vetSecrets } from '../secret-detect.js';
import type { Context } from './types.js';

export interface RememberOpts {
  content: string;
  kind?: MemoryKind;
  scope?: string;
  owner?: string;
  artifactRef?: string;
  tags?: string[];
  /**
   * Optional hook invoked inside the same transaction as the underlying
   * memories INSERT. Used by ingestion connectors to stamp
   * idempotency / cursor rows atomically with the memory row, so a crash
   * mid-write cannot produce a memory without its corresponding side-effect
   * log row (or vice versa). If the callback throws, the INSERT is rolled
   * back and the error is rethrown.
   */
  afterWrite?: (db: DatabaseSyncLike, memoryId: string) => void;
  /** Connector-ingested content an agent doesn't control; gates detectInstruction. CLI/HTTP/MCP never set this. */
  untrusted?: boolean;
}

export interface RememberResult {
  id: string;
  kind: MemoryKind;
  tenantId: string;
  /** Set only when untrusted content was flagged and quarantined instead of stored under its requested scope. */
  quarantined?: { reason: string };
  /** Set only when the content held secret material: untrusted text had it redacted, typed text was stored as sent. */
  warnings?: string[];
}

export function remember(ctx: Context, opts: RememberOpts): RememberResult {
  const vetted = vetSecrets(opts.content, opts.tags ?? [], opts.untrusted === true);
  const detection = opts.untrusted ? detectInstruction(vetted.content) : { flagged: false, reason: null };
  const requestedScope = opts.scope ?? null;
  const entry = createMemory(vetted.content, {
    kind: opts.kind ?? 'distilled',
    scope: detection.flagged ? quarantineScopeFor(requestedScope) : requestedScope,
    owner: opts.owner ?? null,
    artifact_ref: opts.artifactRef ?? null,
    tags: opts.tags,
    tenantId: ctx.tenantId,
    baseHalfLifeDays: loadConfig(ctx.hippoRoot).defaultHalfLifeDays,
  });
  // writeEntry threads ctx.actor.subject into its internal audit hook, so exactly
  // one 'remember' event lands in the log with the supplied actor.
  const afterWrite = detection.flagged
    ? (db: DatabaseSyncLike, memoryId: string) => {
        recordQuarantine(db, {
          tenantId: ctx.tenantId,
          memoryId,
          originalScope: requestedScope,
          reason: detection.reason ?? 'unknown',
          actor: ctx.actor.subject,
        });
        opts.afterWrite?.(db, memoryId);
      }
    : opts.afterWrite;
  writeEntry(ctx.hippoRoot, entry, { actor: ctx.actor.subject, afterWrite });

  const result: RememberResult = { id: entry.id, kind: entry.kind, tenantId: ctx.tenantId };
  if (detection.flagged) result.quarantined = { reason: detection.reason ?? 'unknown' };
  if (vetted.warnings.length > 0) result.warnings = vetted.warnings;
  return result;
}
