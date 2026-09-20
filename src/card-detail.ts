import type { Card, CardComment, CardRun } from './card.js';
import type { SessionHandoff } from './handoff.js';
import { loadCard, loadCardComments, loadCardDeps, loadCardRuns, loadLatestHandoffForCard } from './store.js';

/** A card plus everything `hippo card show` prints about it. */
export interface CardDetail {
  card: Card;
  deps: ReturnType<typeof loadCardDeps>;
  runs: CardRun[];
  comments: CardComment[];
  handoff: SessionHandoff | null;
}

/** Loads the detail behind `hippo card show` and `GET /api/cards/:id` (null when the tenant has no such card); five separate reads, so a write landing between them can show a mixed view, as `card show` always could. */
export function loadCardDetail(hippoRoot: string, tenantId: string, id: string): CardDetail | null {
  const card = loadCard(hippoRoot, tenantId, id);
  if (!card) return null;
  return {
    card,
    deps: loadCardDeps(hippoRoot, tenantId, id),
    runs: loadCardRuns(hippoRoot, tenantId, id),
    comments: loadCardComments(hippoRoot, tenantId, id),
    handoff: loadLatestHandoffForCard(hippoRoot, tenantId, id),
  };
}
