// Project names folded into others, read from the audit trail: the sync files imports under the surviving name, and
// `hippo projects` repair agrees.
import { isObjectLike, isStringValue } from '../../base/session/capture-contract.js';
import type { ProjectFold, ProjectTags } from '../../store/port/project-tags.js';
import type { JsonValue } from '../../base/util/json.js';

function foldOf(value: JsonValue | undefined): ProjectFold[] {
  if (!isObjectLike(value) || Array.isArray(value)) return [];
  const { from, into } = value;
  return isStringValue(from) && isStringValue(into) ? [{ from, into }] : [];
}

export async function foldEdges(tags: Pick<ProjectTags, 'auditEvents'>, tenantId: string): Promise<ProjectFold[]> {
  const merges = await tags.auditEvents(tenantId, 'project_merge');
  const repairs = await tags.auditEvents(tenantId, 'project_repair');
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
  tags: Pick<ProjectTags, 'auditEvents'>,
  tenantId: string,
  names: readonly string[],
): Promise<string[]> {
  return foldedInto(await foldEdges(tags, tenantId), names);
}
