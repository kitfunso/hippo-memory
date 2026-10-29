// What a core path reads from hippo.db's local tier when its root has one; a store without the tier
// leaves it unset, and each path takes its fallback. Each member names only the calls core makes.
import type { LastRecallWrites } from '../base/ports/store/recall-writes.js';
import type { HandoffFilter } from '../base/ports/store/sessions.js';
import type { SessionHandoff } from '../base/session/handoff.js';
import type { ContinuityKey } from '../base/ports/store/types.js';

/** Where context keeps its pick as the last recall, for a later `hippo outcome` with no ids. */
export interface LastRecallFinish {
  /** finishRecall, then the ids kept as the last recall with their trace; the trace id or null. */
  finishRecall(writes: LastRecallWrites, globalRoot: string | undefined): Promise<number | null>;
}

/** The read of an unfinished handoff from an earlier session, which context prints. */
export interface HandoffRead {
  read(
    tenantId: string,
    kind: 'handoff',
    query: HandoffFilter & { readonly sessionId: string | null },
    key: ContinuityKey | null,
  ): Promise<SessionHandoff | null>;
}

/** Filled by a root from the request's own store, so each call runs under that request. */
export interface CoreEnrichment {
  readonly lastRecall?: LastRecallFinish;
  readonly handoff?: HandoffRead;
}
