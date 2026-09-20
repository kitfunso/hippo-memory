export interface Memory {
  id: string;
  content: string;
  tags: string[];
  layer: "buffer" | "episodic" | "semantic";
  strength: number;
  half_life_days: number;
  retrieval_count: number;
  schema_fit: number;
  emotional_valence: "neutral" | "positive" | "negative" | "critical";
  confidence: "verified" | "observed" | "inferred" | "stale";
  aged_out: boolean;
  pinned: boolean;
  created: string;
  last_retrieved: string;
  age_days: number;
  projected_strength_7d: number;
  projected_strength_30d: number;
}

export interface Conflict {
  id: number;
  memory_a_id: string;
  memory_b_id: string;
  reason: string;
  score: number;
  status: string;
}

export interface Stats {
  total: number;
  pinned: number;
  errors: number;
  at_risk: number;
  avg_strength: number;
  avg_half_life: number;
  by_layer: Record<string, number>;
  by_confidence: Record<string, number>;
  aged_out: number;
  embedding_coverage: number;
  open_conflicts: number;
}

export interface Peer {
  project: string;
  count: number;
  latest: string;
}

export interface DashboardConfig {
  defaultHalfLifeDays: number;
  defaultBudget: number;
  embeddingsEnabled: boolean | string;
}

export type EmbeddingIndex = Record<string, number[]>;

// W2c board view: mirrors src/card.ts field for field, same nullability.
export type CardStatus = "backlog" | "ready" | "running" | "blocked" | "review" | "done" | "shelved";

export interface Card {
  id: string;
  title: string;
  status: CardStatus;
  assigneeRuntime: string | null;
  repo: string | null;
  contract: string | null;
  budget: number | null;
  leaseUntil: string | null;
  heartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
  tenantId: string;
  scope: string | null;
}

export interface CardRun {
  id: number;
  card: string;
  runtime: string;
  sessionId: string | null;
  started: string;
  ended: string | null;
  outcome: string | null;
}

export interface CardComment {
  id: number;
  cardId: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface CardDeps {
  parents: string[];
  children: string[];
}

/** Only the handoff fields the UI reads (src/handoff.ts's SessionHandoff has more). */
export interface CardHandoff {
  sessionId: string;
  summary: string;
  updatedAt: string;
}

export interface CardDetail {
  card: Card;
  deps: CardDeps;
  runs: CardRun[];
  comments: CardComment[];
  handoff: CardHandoff | null;
}

export interface CardList {
  cards: Card[];
}
