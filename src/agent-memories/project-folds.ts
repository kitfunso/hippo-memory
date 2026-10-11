// Project names folded into others, read from the audit trail: the sync files imports under the surviving name, and `hippo projects` repair agrees.
import { isObjectLike, isStringValue } from '../core/capture-contract.js';
import type { ProjectTagReads } from '../store/project-tags.js';
import type { JsonValue } from '../util/json.js';

export interface ProjectFold {
  readonly from: string;
  readonly into: string;
}

function foldOf(value: JsonValue | undefined): ProjectFold[] {
  if (!isObjectLike(value) || Array.isArray(value)) return [];
  const { from, into } = value;
  return isStringValue(from) && isStringValue(into) ? [{ from, into }] : [];
}

export function foldEdges(store: Pick<ProjectTagReads, 'auditEvents'>): ProjectFold[] {
  return [
    ...store.auditEvents('project_merge').flatMap((e) => foldOf(e.metadata)),
    ...store.auditEvents('project_repair')
      .flatMap((e) => (Array.isArray(e.metadata.folds) ? e.metadata.folds.flatMap(foldOf) : [])),
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
export function namesFoldedInto(store: Pick<ProjectTagReads, 'auditEvents'>, names: readonly string[]): string[] {
  return foldedInto(foldEdges(store), names);
}
