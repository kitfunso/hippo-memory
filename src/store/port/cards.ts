// The card shapes the Cards group returns.
import type { Card, CardComment, CardRun } from '../../base/records/card.js';
import type { SessionHandoff } from '../../base/session/handoff.js';

/** The ids a card waits on and the ids that wait on it. */
interface CardDeps {
  parents: string[];
  children: string[];
}

/** A card plus everything `hippo card show` prints about it. */
export interface CardDetail {
  card: Card;
  deps: CardDeps;
  runs: CardRun[];
  comments: CardComment[];
  handoff: SessionHandoff | null;
}
