// The audit facts the api and the stores share: the query fields an audit row keeps and the failure counter.
import { blockHash } from '../util/token-text.js';
import { errorFields, errorMessage, log } from '../util/log.js';
import type { AuditOp } from './audit-ops.js';

export type AuditQueryFields = {
  query_hash: string;
  query_length: number;
};

export function auditQueryFields(query: string): AuditQueryFields {
  return {
    query_hash: blockHash(query),
    query_length: query.length,
  };
}

let auditWriteFailures = 0;

/** For callers that keep a mutation when its audit row fails: the failure is logged and counted, never silent. */
export function reportAuditWriteFailure<E>(op: AuditOp, err: E, targetId?: string | null): void {
  auditWriteFailures++;
  log.error(`audit write failed: ${errorMessage(err)}`, { op, target: targetId ?? undefined, ...errorFields(err) });
}

/** Audit rows this process failed to write; the loopback `/health` body reports it. */
export function auditWriteFailureCount(): number {
  return auditWriteFailures;
}

/** Adds the failures a store worker counted on its own thread, so the process reports one number. */
export function addAuditWriteFailures(count: number): void {
  auditWriteFailures += count;
}
