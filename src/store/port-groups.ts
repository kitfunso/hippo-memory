// The required groups port.ts names among StoreGroups beyond its own: sessions, cards, goals, conflicts,
// dormant memories, reports, rejections, the failure log and compactions.
import type { FailureLog, Rejections } from './port/rejections.js';
import type { Compactions } from './port/capture.js';
import type { Sessions } from './port/sessions.js';
import type { Cards } from './port/cards.js';
import type { Goals } from './port/goals.js';
import type { Conflicts } from './port/conflicts.js';
import type { Dormant } from './port/dormant.js';
import type { Reports } from './port/reports.js';

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
