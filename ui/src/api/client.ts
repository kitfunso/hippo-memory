import type {
  Memory,
  Stats,
  Conflict,
  Peer,
  DashboardConfig,
  EmbeddingIndex,
} from "../types";

const BASE = "";

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${path}`);
  }
  return response.json();
}

export function fetchMemories(): Promise<Memory[]> {
  return get<Memory[]>("/api/memories");
}

export function fetchStats(): Promise<Stats> {
  return get<Stats>("/api/stats");
}

export function fetchConflicts(): Promise<Conflict[]> {
  return get<Conflict[]>("/api/conflicts");
}

export function fetchPeers(): Promise<Peer[]> {
  return get<Peer[]>("/api/peers");
}

export function fetchConfig(): Promise<DashboardConfig> {
  return get<DashboardConfig>("/api/config");
}

export function fetchEmbeddings(): Promise<EmbeddingIndex> {
  return get<EmbeddingIndex>("/api/embeddings");
}
