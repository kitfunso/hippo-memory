// Project names folded into others, read from the audit trail: the sync files imports under the surviving name, and
// `hippo projects` repair agrees.
import { isObjectLike, isStringValue } from '../../base/session/capture-contract.js';
import type { ProjectFold } from '../../store/port/project-tags.js';
import type { AuditLog } from '../../store/port/audit.js';
import type { AuditEvent } from '../../store/port/types.js';
import type { JsonValue } from '../../base/util/json.js';
import { MAX_AUDIT_LIMIT } from '../../base/util/limits.js';

type AuditReads = Pick<AuditLog, 'listAuditEvents'>;

/** The tenant's newest `op` audit rows, as many as one audit read returns. */
export function projectAudit(
  audit: AuditReads,
  tenantId: string,
  op: 'project_merge' | 'project_repair',
): Promise<AuditEvent[]> {
  return audit.listAuditEvents({ tenantId, op, limit: MAX_AUDIT_LIMIT });
}

function foldOf(value: JsonValue | undefined): ProjectFold[] {
  if (!isObjectLike(value) || Array.isArray(value)) return [];
  const { from, into } = value;
  return isStringValue(from) && isStringValue(into) ? [{ from, into }] : [];
}

export async function foldEdges(audit: AuditReads, tenantId: string): Promise<ProjectFold[]> {
  const merges = await projectAudit(audit, tenantId, 'project_merge');
  const repairs = await projectAudit(audit, tenantId, 'project_repair');
  return [
    ...merges.flatMap((e) => foldOf(e.metadata)),
    ...repairs.flatMap((e) => (Array.isArray(e.metadata.folds) ? e.metadata.folds.flatMap(foldOf) : [])),
  ];
}

export function foldedInto(edges: readonly ProjectFold[], names: readonly string[]): string[] {
  const seen = new Set(names);
  let grew = true;
  while (grew) {
    grew = false;
    for (const { from, into } of edges) {
      if (!seen.has(into) || seen.has(from)) continue;
      seen.add(from);
      grew = true;
    }
  }
  return [...seen].filter((n) => !names.includes(n));
}

/** Names folded, directly or through others, into one of `names`; the sync moves imports still filed under them. */
export async function namesFoldedInto(
  audit: AuditReads,
  tenantId: string,
  names: readonly string[],
): Promise<string[]> {
  return foldedInto(await foldEdges(audit, tenantId), names);
}
