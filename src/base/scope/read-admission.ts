// Which rows an ambient load and a summary drill-down admit, as plain data: a store on a worker thread applies the same
// rule the caller would, since a function cannot cross a thread.
import { COMPACTION_MEMORY_TAG, type MemoryEntry } from '../memory/memory.js';
import { isWorthSurfacing } from '../memory/memory-quality.js';
import { classifyOriginProject, projectNames, type ProjectRef } from './project-identity.js';
import { passesScopeFilterForRecall } from './recall-scope.js';
import { isSessionDigestRow } from '../session/session-digest-row.js';
import { detectSecret } from '../util/secret-detect.js';

/** The rows an ambient read admits. */
export interface AmbientAdmission {
  /**
   * A secret-flagged row passes only inside this project, and another project's row only with `includeCrossProject`.
   */
  readonly currentProject: ProjectRef;
  readonly includeCrossProject: boolean;
  /** Envelope scope asked for by name; absent applies recall's default deny. */
  readonly exactScope?: string;
  /** The reader's personal scope, which the default deny admits. */
  readonly ownScope?: string;
  /** The reader's session, whose own compaction items are left out. */
  readonly ownSessionId?: string;
  /** The session of a printed transcript handoff, which already carries the closing message its digest rows hold. */
  readonly handoffSessionId?: string;
}

/**
 * Why an ambient load leaves a row out: `admission` refused it, or it passed but is neither pinned nor worth showing.
 */
export type AmbientRefusalReason = 'admission' | 'quality';

/** The rows a summary drill-down reads: recall's scope rule, and with `project` set, no row of another project. */
export interface DescendantAdmission {
  /** The reader's personal scope, which the default deny admits. */
  readonly ownScope?: string;
  readonly project?: ProjectRef;
}

/** The secret half of the ambient policy alone: a flagged row is admitted only inside its owning project. */
export function ambientSecretAdmit(e: MemoryEntry, currentProject: ProjectRef): boolean {
  if (!detectSecret(e).flagged) return true;
  const origin = e.originProject;
  if (origin === undefined || origin === null || origin === '') return false;
  return projectNames(currentProject).includes(origin);
}

/** The ambient envelope contextGet's pools and the two-store search share: handoff digest, secret, scope, origin. */
export function ambientEnvelopeAdmits(e: MemoryEntry, a: AmbientAdmission): boolean {
  if (a.handoffSessionId !== undefined && e.sourceSessionId === a.handoffSessionId && isSessionDigestRow(e)) {
    return false;
  }
  if (!ambientSecretAdmit(e, a.currentProject)) return false;
  if (!passesScopeFilterForRecall(e.scope ?? null, a.exactScope, a.ownScope)) return false;
  if (a.includeCrossProject) return true;
  return classifyOriginProject(e.originProject, a.currentProject) !== 'cross-project';
}

// Superseded rows go first because the envelope regex-scans content for secrets.
export function ambientAdmits(e: MemoryEntry, a: AmbientAdmission): boolean {
  return !e.supersededBy && !isOwnCompactionItem(e, a.ownSessionId) && ambientEnvelopeAdmits(e, a);
}

/** Why an ambient load leaves `e` out, or null when it keeps it. */
export function ambientRefusal(e: MemoryEntry, a: AmbientAdmission): AmbientRefusalReason | null {
  if (!ambientAdmits(e, a)) return 'admission';
  return e.pinned || isWorthSurfacing(e) ? null : 'quality';
}

export function descendantAdmits(row: Pick<MemoryEntry, 'scope' | 'originProject'>, a: DescendantAdmission): boolean {
  return (
    passesScopeFilterForRecall(row.scope ?? null, undefined, a.ownScope) &&
    (!a.project || classifyOriginProject(row.originProject, a.project) !== 'cross-project')
  );
}

function isOwnCompactionItem(e: MemoryEntry, ownSessionId: string | undefined): boolean {
  return !!ownSessionId && e.sourceSessionId === ownSessionId && e.tags.includes(COMPACTION_MEMORY_TAG);
}
