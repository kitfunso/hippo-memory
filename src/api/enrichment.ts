// What a core path reads from hippo.db's local tier when its root has one; a store without the tier
// leaves it unset, and each path takes its fallback. Each member names only the calls core makes.
import type { StoreHome } from '../base/ports/store/folder-files.js';
import type { LedgerTurn, PilotArmOptions, TokenSurface } from '../base/ports/store/ledger.js';
import type { PilotArm } from '../base/session/pilot-arm.js';
import type { LastSent } from '../base/session/skip-unchanged.js';
import type { ApiCall } from '../base/session/transcript-calls.js';
import type { LastRecallWrites } from '../base/ports/store/recall-writes.js';
import type { HandoffFilter } from '../base/ports/store/sessions.js';
import type { SessionHandoff } from '../base/session/handoff.js';
import type { ContinuityKey } from '../base/ports/store/types.js';
import type { GraphWalk } from '../domain/graph/recall.js';

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

/** GET /ready's probe of the store. */
export interface ReadinessPing {
  ping(): Promise<void>;
}

/** The ledger calls core makes: a hook books its turn and reads its last send, a session takes
 * its pilot arm, and session end books its re-reads. */
export interface LedgerBook {
  recordTurn(turn: LedgerTurn): Promise<void>;
  lastSent(
    tenantId: string,
    sessionId: string | null | undefined,
    surface: TokenSurface,
  ): Promise<LastSent | null>;
  pilotArm(
    tenantId: string,
    sessionId: string,
    rateBp: number,
    opts: PilotArmOptions,
  ): Promise<PilotArm>;
  replaceRereads(tenantId: string, sessionId: string, calls: readonly ApiCall[]): Promise<number>;
}

/** Where a store sits: the prompt hook reads its folder, a delivery row its hash. */
export interface FolderHome {
  home(): Promise<StoreHome>;
}

/** The rows a tenant wrote since the store's last sleep, which a write's auto-sleep counts. */
export interface SleepCount {
  createdSinceLastSleep(tenantId: string, now: Date): Promise<number>;
}

/** Filled by a root from the request's own store, so each call runs under that request. */
export interface CoreEnrichment {
  readonly lastRecall?: LastRecallFinish;
  readonly handoff?: HandoffRead;
  readonly readiness?: ReadinessPing;
  /** The graph recall's expansion and graph list walk. */
  readonly graph?: GraphWalk;
  /** The token and delivery ledger the prompt hook and session hooks book to. */
  readonly ledger?: LedgerBook;
  readonly folderFiles?: FolderHome;
  /** Unset, a write starts no auto-sleep. */
  readonly sleepCount?: SleepCount;
}

/** What a core path reads from the operator's global store's local tier, filled by the root that
 * opened it. */
export interface GlobalEnrichment {
  /** The global graph CLI recall and the published hybridSearch also walk. */
  readonly graph?: GraphWalk;
  /** The ledger a hook books to when its own store keeps none, and where that store sits. */
  readonly ledger?: LedgerBook;
  readonly folderFiles?: FolderHome;
}
