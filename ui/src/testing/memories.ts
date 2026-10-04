import type { MemoryDetail, MemoryPage, MemoryRow, ProjectDetail, ProjectSummary, ScatterPoints } from "../types";
import { type Handler, fetchRouter, json, makeDetail, makeOverview, makeProject } from "./fixtures";

/** A memory table row; `m1`, `m2`... are the ids tests use. */
export function makeRow(id: string, over: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id,
    content: `memory ${id}`,
    truncated: false,
    layer: "semantic",
    band: "strong",
    strength: 0.8,
    retrievals: 3,
    lastRetrievedDays: 2,
    ageDays: 12,
    confidence: "observed",
    scope: null,
    pinned: false,
    wrong: false,
    inConflict: false,
    ...over,
  };
}

/** The row slice a page request asks for, with the chip counts and decay a real page carries. */
export function makePage(all: readonly MemoryRow[], offset: number, limit: number, snapshotId = 1): MemoryPage {
  return {
    snapshotId,
    total: all.length,
    offset,
    limit,
    counts: { all: all.length, risk: 0, pinned: 0, conflict: 0 },
    decay: { now: [all.length, 0, 0], in7d: [all.length, 0, 0], in30d: [all.length, 0, 0], pinned: 0 },
    rows: all.slice(offset, offset + limit),
  };
}

/** A route handler that pages `all` by the request's offset and limit; `snapshotId` may move between requests. */
export function pageHandler(all: readonly MemoryRow[], snapshotId: () => number = () => 1): Handler {
  return (url) => json(makePage(all, Number(url.searchParams.get("offset") ?? 0), Number(url.searchParams.get("limit") ?? 100), snapshotId()));
}

/** A drawer detail for a row. */
export function makeMemory(id: string, over: Partial<MemoryDetail> = {}): MemoryDetail {
  return {
    snapshotId: 1,
    id,
    content: `memory ${id}`,
    layer: "semantic",
    band: "strong",
    tags: [],
    strength: 0.8,
    strength7d: 0.7,
    strength30d: 0.5,
    halfLifeDays: 30,
    retrievals: 3,
    lastRetrieved: "2026-10-01T00:00:00.000Z",
    created: "2026-09-01T00:00:00.000Z",
    ageDays: 12,
    schemaFit: 0.5,
    valence: "neutral",
    confidence: "observed",
    agedOut: false,
    pinned: false,
    wrong: false,
    projectKey: "p:hippo",
    projectName: "hippo",
    scope: null,
    tenant: "default",
    kind: "memory",
    embedded: true,
    conflicts: [],
    ...over,
  };
}

/** A project payload with real scatter points: `[age, strength, layerIdx, band]` per id. */
export function makePointsDetail(summary: ProjectSummary, points: ScatterPoints["points"], ids: string[]): ProjectDetail {
  return { snapshotId: 1, summary, scatter: { mode: "points", maxAgeDays: 90, points, ids } };
}

/** The hippo project served from `rows`, with a drawer detail per row; `extra` adds or replaces routes and `snapshot` is the id every read answers with. */
export function hippoRoutes(rows: readonly MemoryRow[], extra: Record<string, Handler> = {}, snapshot: () => number = () => 1) {
  const hippo = makeProject("hippo", { live: rows.length, atRisk: 0 });
  const details = Object.fromEntries(rows.map((r) => [`/api/memory/${r.id}`, () => json(makeMemory(r.id, { snapshotId: snapshot() }))] as const));
  return fetchRouter({
    "/api/overview": () => json(makeOverview([hippo], { snapshotId: snapshot() })),
    "/api/projects/p%3Ahippo": () => json(makeDetail(hippo, snapshot())),
    "/api/projects/p%3Ahippo/memories": pageHandler(rows, snapshot),
    ...details,
    ...extra,
  });
}
