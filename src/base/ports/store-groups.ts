// The optional groups only feature verbs reach: connectors, the records kept beside memories, and
// review. A store without them still serves recall, remember and context; each surface leaves out
// what needs them when it binds.
import type { ConnectorEvents, ConnectorWrites } from './store/connectors.js';
import type { Quarantine } from './store/quarantine.js';
import type { Objects } from './store/objects.js';
import type { Cards } from './store/cards.js';
import type { Conflicts } from './store/conflicts.js';
import type { Rejections } from './store/rejections.js';

/** The connector webhooks and verbs, and the queue a flagged connector row waits in; without
 * them, both webhooks and /v1/quarantine answer 501. */
export interface ConnectorGroups {
  /** A write that carries a connector event or untrusted content. */
  readonly connectorWrites: ConnectorWrites;
  /** Both connector webhooks' dedup, dead letters and tenant routing. */
  readonly connectorEvents: ConnectorEvents;
  readonly quarantine: Quarantine;
}

/** Records kept beside memories; without them, the object routes answer 501 and `hippo card`
 * refuses. */
export interface RecordGroups {
  /** Decisions, incidents, policies, skills, predictions and the other object kinds. */
  readonly objects: Objects;
  readonly cards: Cards;
}

/** What memories disagree on and the values an operator refused; without them, hippo_conflicts
 * and hippo_resolve answer not ported. */
export interface ReviewGroups {
  /** Conflict listing and resolving. */
  readonly conflicts: Conflicts;
  readonly rejections: Rejections;
}
