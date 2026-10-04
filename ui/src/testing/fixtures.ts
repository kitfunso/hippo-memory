import { COARSE_QUERY, PHONE_QUERY } from "../hooks/useMediaQuery";
import type { Kpi, Overview, ProjectDetail, ProjectSummary } from "../types";

/** Test builders and a path-routed fetch stub for the Health view; not imported by app code. */
export function makeProject(name: string, over: Partial<ProjectSummary> = {}): ProjectSummary {
  const live = over.live ?? 100;
  const atRisk = over.atRisk ?? 10;
  return {
    key: `p:${name}`,
    name,
    kind: "project",
    live,
    atRisk,
    share: live ? atRisk / live : 0,
    pinned: 2,
    embedded: live,
    openConflicts: 0,
    lastRetrievedDays: 3,
    bands: { pinned: 2, strong: live - atRisk - 2 - 8, fading: 8, atRisk },
    layers: { buffer: 0, episodic: live / 2, semantic: live / 2, trace: 0 },
    ...over,
  };
}

function kpi(id: Kpi["id"], label: string, value: number, series: number[] | null = null, delta = "no change"): Kpi {
  return { id, label, value, delta, series };
}

const RAMP = Array.from({ length: 91 }, (_, i) => 100 + i);

export function makeOverview(projects: ProjectSummary[], over: Partial<Overview> = {}): Overview {
  const total = projects.reduce((s, p) => s + p.live, 0);
  return {
    snapshotId: 1,
    generatedAt: new Date().toISOString(),
    total,
    excluded: { superseded: 0, archived: 0, quarantined: 0 },
    embeddingCoverage: 1,
    kpis: [
      kpi("total", "Total memories", total, RAMP),
      kpi("projects", "Projects", projects.filter((p) => p.kind === "project").length, RAMP),
      kpi("atRiskShare", "At-risk share, 30d", 0.1, null, "10.0% now at strength under 0.2"),
      kpi("openConflicts", "Open conflicts", 3, null, "in 1 projects"),
      kpi("embeddingCoverage", "Embedding coverage", 1, null, "0 not embedded"),
    ],
    projects,
    mostAtRisk: projects.map((p) => p.key),
    mostConflicts: projects.filter((p) => p.openConflicts > 0).map((p) => p.key),
    ...over,
  };
}

export function makeDetail(summary: ProjectSummary, snapshotId = 1): ProjectDetail {
  return { snapshotId, summary, scatter: { mode: "points", maxAgeDays: 90, points: [], ids: [] } };
}

export type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

export function json<B>(body: B, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A fetch stub that routes by pathname and records every request as `path?query`. */
export function fetchRouter(routes: Record<string, Handler>) {
  const calls: string[] = [];
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "http://localhost");
    calls.push(url.pathname + url.search);
    const handler = routes[url.pathname];
    if (!handler) throw new Error(`no route for ${url.pathname}`);
    return handler(url, init);
  };
  return { stub, calls };
}

/** Makes `matchMedia` match exactly these queries; remove it again with `Reflect.deleteProperty(window, "matchMedia")`. */
export function stubMedia(...matching: string[]): void {
  window.matchMedia = (query: string) => {
    const list: Partial<MediaQueryList> = { matches: matching.includes(query), media: query, addEventListener() {}, removeEventListener() {} };
    // SAFETY: the app reads only matches and the two listener methods.
    return list as MediaQueryList;
  };
}

/** Makes `matchMedia` report the phone width, which is also a touch screen. */
export function stubPhone(): void {
  stubMedia(PHONE_QUERY, COARSE_QUERY);
}
