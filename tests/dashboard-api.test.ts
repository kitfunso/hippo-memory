// The read routes of the Health view: overview, project, memory page, detail and search, their validation, and the removed endpoints.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Layer, type MemoryEntry } from '../src/memory.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { buildSnapshot } from '../src/dashboard-snapshot.js';
import { buildOverview, buildProjectDetail } from '../src/dashboard-queries.js';
import type {
  MemoryDetail, MemoryPage, Overview, ProjectDetail, ScatterGrid, ScatterPoints, SearchResult,
} from '../src/dashboard-types.js';
import {
  NOW, call, get, isoAgo, makeStore, parse, postJson, seed, startDashboard, type RunningDashboard, type TmpStore,
} from './_helpers/dashboard-fixture.js';

const AT_RISK = { half_life_days: 10, created: isoAgo(0), last_retrieved: isoAgo(0) } as const;
const FADING = { half_life_days: 100, created: isoAgo(150), last_retrieved: isoAgo(150) } as const;
const LONG_TEXT = `long ${'x'.repeat(295)}`;

let store: TmpStore;
let dash: RunningDashboard;
let longId: string;

beforeAll(async () => {
  store = makeStore('hippo-dash-api');
  seed(store.hippoRoot, 'zeta strong');
  seed(store.hippoRoot, 'risk of loss', AT_RISK);
  seed(store.hippoRoot, 'mid fading', FADING);
  seed(store.hippoRoot, 'pinned fact', { ...AT_RISK, pinned: true });
  seed(store.hippoRoot, 'semantic fact', { layer: Layer.Semantic });
  seed(store.hippoRoot, 'buffer fact', { layer: Layer.Buffer });
  longId = seed(store.hippoRoot, LONG_TEXT).id;
  seed(store.hippoRoot, 'beta only', { origin_project: 'beta' });
  dash = await startDashboard(store.hippoRoot);
});

afterAll(async () => {
  await dash.close();
  store.cleanup();
});

const memories = (query = ''): Promise<MemoryPage> =>
  get(dash.port, `/api/projects/${encodeURIComponent('p:alpha')}/memories${query}`).then((r) => {
    expect(r.status).toBe(200);
    return parse<MemoryPage>(r);
  });

describe('overview and project', () => {
  it('lists every project with the totals the KPIs repeat', async () => {
    const reply = await get(dash.port, '/api/overview');
    const overview = parse<Overview>(reply);

    expect(reply.status).toBe(200);
    expect(overview.total).toBe(8);
    expect(overview.projects.map((p) => p.key).sort()).toEqual(['p:alpha', 'p:beta']);
    expect(overview.kpis.map((k) => k.id)).toEqual(['total', 'projects', 'atRiskShare', 'openConflicts', 'embeddingCoverage']);
    expect(overview.kpis[0].value).toBe(8);
    expect(overview.kpis[0].series).toHaveLength(91);
    expect(overview.mostAtRisk[0]).toBe('p:alpha');
    expect(overview.generatedAt).toBe(new Date(NOW).toISOString());
  });

  it('returns a project with a points scatter, and 404 for an unknown key', async () => {
    const ok = await get(dash.port, `/api/projects/${encodeURIComponent('p:alpha')}`);
    const detail = parse<ProjectDetail>(ok);
    // SAFETY: a 7-member project is under the 4,000 cut-off, so the scatter is the points shape.
    const points = detail.scatter as ScatterPoints;

    expect(ok.status).toBe(200);
    expect(detail.summary.live).toBe(7);
    expect(points.mode).toBe('points');
    expect(points.points).toHaveLength(7);
    expect(points.ids).toHaveLength(7);

    expect((await get(dash.port, `/api/projects/${encodeURIComponent('p:nope')}`)).status).toBe(404);
    expect((await get(dash.port, '/api/projects/p:alpha/extra/path')).status).toBe(404);
  });

  it('switches a project over 4,000 memories to a density grid', () => {
    const entries = Array.from({ length: 4_001 }, (_, i) => ({
      ...createMemory(`bulk ${i}`, { tags: [] }),
      origin_project: 'big',
      created: isoAgo(i % 300),
      last_retrieved: isoAgo(i % 300),
    }));
    const snap = buildSnapshot({ id: 1, tenantId: 'default', nowMs: NOW, entries, openConflicts: [], embeddedIds: new Set() });

    // SAFETY: 4,001 members is over the cut-off, so the scatter is the grid shape.
    const grid = buildProjectDetail(snap, 'p:big')!.scatter as ScatterGrid;
    const counted = grid.cells.reduce((sum, layer) => sum + layer.reduce((a, b) => a + b, 0), 0);

    expect(grid.mode).toBe('grid');
    expect([grid.cols, grid.rows]).toEqual([64, 32]);
    expect(counted).toBe(4_001);
  });
});

describe('KPI series', () => {
  const seriesOf = (id: 'total' | 'projects', entries: MemoryEntry[]): number[] => {
    const snap = buildSnapshot({ id: 1, tenantId: 'default', nowMs: NOW, entries, openConflicts: [], embeddedIds: new Set() });
    return buildOverview(snap).kpis.find((k) => k.id === id)!.series!;
  };
  const aged = (days: number, project: string): MemoryEntry => ({
    ...createMemory(`aged ${days}`, { tags: [] }),
    origin_project: project,
    created: isoAgo(days),
    last_retrieved: isoAgo(days),
  });

  it('sends 91 cumulative points whose first-to-last difference counts memories created inside the window', () => {
    const total = seriesOf('total', [aged(89.5, 'a'), aged(95, 'b'), aged(10, 'c'), aged(0.2, 'c')]);

    expect(total).toHaveLength(91);
    expect(total[0]).toBe(1);
    expect(total[90]).toBe(4);
    expect(total[90] - total[0]).toBe(3);
    expect(total[90] - total[83]).toBe(1);
    expect(total[90] - total[60]).toBe(2);
  });

  it('counts a project from its first memory, so a project first seen 95 days ago stays in the base', () => {
    const projects = seriesOf('projects', [aged(89.5, 'new'), aged(95, 'old'), aged(3, 'old')]);

    expect(projects[0]).toBe(1);
    expect(projects[90] - projects[0]).toBe(1);
  });
});

describe('memory page', () => {
  it('sorts weakest first by default, and by content on request', async () => {
    const byStrength = await memories();
    expect(byStrength.rows[0].content).toBe('mid fading');
    expect(byStrength.total).toBe(7);

    const byContent = await memories('?sort=content&dir=asc');
    const names = byContent.rows.map((r) => r.content.toLowerCase());
    expect(names).toEqual([...names].sort());
  });

  it('applies the chip and reports counts for the whole filtered set', async () => {
    const risk = await memories('?chip=risk');

    expect(risk.rows.map((r) => r.band)).toEqual(['atRisk']);
    expect(risk.total).toBe(1);
    expect(risk.counts).toEqual({ all: 7, risk: 1, pinned: 1, conflict: 0 });
    expect((await memories('?chip=pinned')).rows.map((r) => r.content)).toEqual(['pinned fact']);
  });

  it('filters by layer, by the age and strength brush, and by search text', async () => {
    expect((await memories('?layers=semantic')).rows.map((r) => r.content)).toEqual(['semantic fact']);
    expect((await memories('?layers=buffer,semantic')).total).toBe(2);
    expect((await memories('?smax=0.5')).rows.map((r) => r.content)).toEqual(['mid fading']);
    expect((await memories('?amin=100')).rows.map((r) => r.content)).toEqual(['mid fading']);
    expect((await memories('?q=RISK')).rows.map((r) => r.content)).toEqual(['risk of loss']);
    // One character is below the search minimum, so it filters nothing.
    expect((await memories('?q=z')).total).toBe(7);
  });

  it('pages without changing the order, and decay counts follow the filter', async () => {
    const all = await memories('?sort=content&dir=asc&limit=100');
    const second = await memories('?sort=content&dir=asc&limit=2&offset=2');

    expect(second.rows.map((r) => r.id)).toEqual(all.rows.slice(2, 4).map((r) => r.id));
    expect(second.total).toBe(7);
    expect(second.limit).toBe(2);
    expect(second.decay.pinned).toBe(1);
    expect(second.decay.now.reduce((a, b) => a + b, 0)).toBe(7);
  });

  it('cuts row content to 240 characters and returns the full text from the detail route', async () => {
    const row = (await memories('?q=long')).rows[0];
    expect(row.content).toHaveLength(240);
    expect(row.truncated).toBe(true);

    const detail = parse<MemoryDetail>(await get(dash.port, `/api/memory/${longId}`));
    expect(detail.content).toBe(LONG_TEXT);
    expect(detail.projectKey).toBe('p:alpha');
  });

  it('answers 400 for each invalid query value', async () => {
    const bad = [
      'limit=0', 'limit=501', 'limit=10abc', 'limit=1.5', 'offset=-1', 'offset=abc', 'sort=nope', 'dir=up',
      'chip=all,risk', 'layers=', 'layers=episodic,nope', 'amin=5&amax=1', 'smin=x', `q=${'a'.repeat(201)}`,
    ];
    for (const query of bad) {
      const reply = await get(dash.port, `/api/projects/${encodeURIComponent('p:alpha')}/memories?${query}`);
      expect(reply.status, query).toBe(400);
      expect(parse<{ error: string }>(reply).error.length).toBeGreaterThan(0);
    }
  });
});

describe('search and detail', () => {
  it('counts hits per project and matches project names', async () => {
    const hits = parse<SearchResult>(await get(dash.port, '/api/search?q=FACT'));
    expect(hits.total).toBe(3);
    expect(hits.hits).toEqual({ 'p:alpha': 3 });

    const names = parse<SearchResult>(await get(dash.port, '/api/search?q=bet'));
    expect(names.nameMatches.map((m) => m.key)).toEqual(['p:beta']);
    expect(names.hits).toEqual({ 'p:beta': 1 });
  });

  it('rejects a search shorter than two or longer than 200 characters', async () => {
    expect((await get(dash.port, '/api/search?q=a')).status).toBe(400);
    expect((await get(dash.port, '/api/search')).status).toBe(400);
    expect((await get(dash.port, `/api/search?q=${'a'.repeat(201)}`)).status).toBe(400);
  });

  it('answers 404 for an unknown memory and 400 for a malformed id', async () => {
    expect((await get(dash.port, '/api/memory/mem_nope')).status).toBe(404);
    expect((await get(dash.port, '/api/memory/a.b')).status).toBe(400);
  });
});

describe('removed endpoints', () => {
  it('answers the existing JSON 404 for every old route', async () => {
    for (const path of ['/api/memories', '/api/embeddings', '/api/stats', '/api/conflicts', '/api/peers', '/api/config']) {
      const reply = await get(dash.port, path);
      expect(reply.status, path).toBe(404);
      expect(reply.body).toBe('{"error":"Not found"}');
    }
    expect((await postJson(dash.port, '/api/star/x')).status).toBe(404);
    expect((await call(dash.port, 'DELETE', '/api/overview')).status).toBe(404);
  });
});
