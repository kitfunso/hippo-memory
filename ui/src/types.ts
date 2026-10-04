/** Wire types of the Health view: mirrors src/dashboard-types.ts field for field. */

export type Layer = 'buffer' | 'episodic' | 'semantic' | 'trace';
export type Band = 'pinned' | 'strong' | 'fading' | 'atRisk';
export type ProjectKind = 'project' | 'global' | 'unassigned';

/** One origin project's aggregates; `key` is `p:<name>`, `global` or `unassigned`. */
export interface ProjectSummary {
  key: string;
  name: string;
  kind: ProjectKind;
  live: number;
  atRisk: number;
  share: number;
  pinned: number;
  embedded: number;
  openConflicts: number;
  lastRetrievedDays: number | null;
  bands: Record<Band, number>;
  layers: Record<Layer, number>;
}

/** One KPI card; `series` is 90 daily points, oldest first, or null when hippo recorded no history. */
export interface Kpi {
  id: 'total' | 'projects' | 'atRiskShare' | 'openConflicts' | 'embeddingCoverage';
  label: string;
  value: number;
  delta: string;
  series: number[] | null;
}

export interface Overview {
  snapshotId: number;
  generatedAt: string;
  total: number;
  excluded: { superseded: number; archived: number; quarantined: number };
  embeddingCoverage: number | null;
  kpis: Kpi[];
  projects: ProjectSummary[];
  mostAtRisk: string[];
  mostConflicts: string[];
}

export interface ScatterPoints {
  mode: 'points';
  maxAgeDays: number;
  points: [number, number, number, number][];
  ids: string[];
}

export interface ScatterGrid {
  mode: 'grid';
  maxAgeDays: number;
  cols: 64;
  rows: 32;
  cells: [number[], number[], number[], number[]];
}

export interface ProjectDetail {
  snapshotId: number;
  summary: ProjectSummary;
  scatter: ScatterPoints | ScatterGrid;
}

export interface DecayOutlook {
  now: [number, number, number];
  in7d: [number, number, number];
  in30d: [number, number, number];
  pinned: number;
}

export interface MemoryRow {
  id: string;
  content: string;
  truncated: boolean;
  layer: Layer;
  band: Band;
  strength: number;
  retrievals: number;
  lastRetrievedDays: number;
  ageDays: number;
  confidence: string;
  scope: string | null;
  pinned: boolean;
  wrong: boolean;
  inConflict: boolean;
}

export interface MemoryPage {
  snapshotId: number;
  total: number;
  offset: number;
  limit: number;
  counts: { all: number; risk: number; pinned: number; conflict: number };
  decay: DecayOutlook;
  rows: MemoryRow[];
}

export interface MemoryConflictDetail {
  id: number;
  reason: string;
  score: number;
  other: { id: string; content: string; strength: number; retrievals: number };
}

export interface MemoryDetail {
  snapshotId: number;
  id: string;
  content: string;
  layer: Layer;
  band: Band;
  tags: string[];
  strength: number;
  strength7d: number;
  strength30d: number;
  halfLifeDays: number;
  retrievals: number;
  lastRetrieved: string;
  created: string;
  ageDays: number;
  schemaFit: number;
  valence: string;
  confidence: string;
  agedOut: boolean;
  pinned: boolean;
  wrong: boolean;
  projectKey: string;
  projectName: string;
  scope: string | null;
  tenant: string;
  kind: string;
  embedded: boolean;
  conflicts: MemoryConflictDetail[];
}

export interface SearchResult {
  snapshotId: number;
  q: string;
  total: number;
  hits: Record<string, number>;
  nameMatches: { key: string; name: string; live: number }[];
}

/** Body of `POST /api/conflicts/:id/resolve` on success. */
export interface ResolveResult {
  ok: true;
  conflictId: number;
  keptId: string;
  weakenedId: string;
}

/** Body of `POST /api/memory/:id/forget` on success. */
export interface ForgetResult {
  ok: true;
  id: string;
}

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
