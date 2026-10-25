// The required groups port.ts names among StoreGroups beyond its own: sessions, cards, goals, conflicts,
// dormant memories, reports, rejections, the failure log and compactions.
import type { FailureLog, Rejections } from './store/rejections.js';
import type { Compactions } from './store/capture.js';
import type { Sessions } from './store/sessions.js';
import type { Cards } from './store/cards.js';
import type { Goals } from './store/goals.js';
import type { Conflicts } from './store/conflicts.js';
import type { Dormant } from './store/dormant.js';
import type { Reports } from './store/reports.js';

/** The groups StoreGroups gains beyond port.ts, each required and set whole. */
export interface SessionAndAdminGroups {
  /** The continuity, session-end and working-memory paths. */
  readonly sessions: Sessions;
  readonly cards: Cards;
  readonly goals: Goals;
  /** Conflict listing and resolving. */
  readonly conflicts: Conflicts;
  readonly dormant: Dormant;
  /** Status, tokens, failures and the memory listings. */
  readonly reports: Reports;
  readonly rejections: Rejections;
  readonly failureLog: FailureLog;
  readonly compactions: Compactions;
}
