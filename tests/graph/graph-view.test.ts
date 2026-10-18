/**
 * E3 graph observability + visualization - tests.
 * Docs: docs/plans/2026-06-02-graph-observability.md
 *
 * READ-ONLY over the graph: buildGraphModel (loadEntities/loadRelations), the
 * deterministic layout, the self-contained HTML viewer (XSS-escaped), the JSON
 * Canvas export, and the GET /v1/graph route. Real SQLite, no mocks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { saveDecision } from '../../src/objects/decisions.js';
import { savePolicy } from '../../src/objects/policies.js';
import { saveCustomerNote } from '../../src/objects/customer-notes.js';
import { extractGraph } from '../../src/graph/extract.js';
import {
  buildGraphModel,
  layoutGraph,
  renderGraphHtml,
  renderGraphCanvas,
  type GraphModel,
} from '../../src/graph/view.js';
import { serve, type ServerHandle } from '../../src/server.js';
import { makeRoot } from '../_helpers/make-root.js';
import { objectsAt } from '../_helpers/objects-at.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { loadConfig } from '../../src/core/config.js';

beforeEach(() => {
  vi.stubEnv('HIPPO_ALLOW_KEYLESS_LOCAL', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const T = 'default';

/** Seed: a policy + a decision that names it -> 2 entities + 1 `references` edge. */
async function seedGraph(home: string, tenant = T): Promise<void> {
  await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, tenant, {
    policyName: 'RetryPolicy',
    policyText: 'retry up to 3x',
  });
  await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, tenant, {
    decisionText: 'We adopt RetryPolicy across all services',
  });
  await extractGraph(sqliteStore(home), tenant);
}

describe('graph-view: buildGraphModel (real DB)', () => {
  let home: string;
  beforeEach(() => {
    home = makeRoot('graphview');
  });
  afterEach(() => {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('1. maps entities -> nodes and relations -> edges', async () => {
    await seedGraph(home);
    const m = await buildGraphModel(sqliteStore(home).graphReads, T);
    expect(m.nodes).toHaveLength(2);
    expect(m.nodes.some((n) => n.type === 'policy' && n.name === 'RetryPolicy')).toBe(true);
    expect(m.nodes.some((n) => n.type === 'decision')).toBe(true);
    expect(m.edges).toHaveLength(1);
    expect(m.edges[0].relType).toBe('references');
    expect(m.truncated).toBe(false);
  });

  it('2. --entity focus returns the match + its 1-hop neighbours + edges among them', async () => {
    await seedGraph(home);
    const m = await buildGraphModel(sqliteStore(home).graphReads, T, { entity: 'RetryPolicy' });
    // RetryPolicy + the decision that references it.
    expect(m.nodes).toHaveLength(2);
    expect(m.nodes.some((n) => n.name === 'RetryPolicy')).toBe(true);
    expect(m.edges).toHaveLength(1);
  });

  it('3. unknown --entity yields an empty model', async () => {
    await seedGraph(home);
    const m = await buildGraphModel(sqliteStore(home).graphReads, T, { entity: 'NoSuchThing' });
    expect(m.nodes).toHaveLength(0);
    expect(m.edges).toHaveLength(0);
  });

  it('4. empty store -> empty model, truncated false', async () => {
    const m = await buildGraphModel(sqliteStore(home).graphReads, T);
    expect(m).toEqual({ nodes: [], edges: [], truncated: false });
  });

  it('5. truncated flag set when a loader hits its limit', async () => {
    await seedGraph(home);
    const m = await buildGraphModel(sqliteStore(home).graphReads, T, { limit: 1 }); // 2 entities, limit 1 -> truncated
    expect(m.truncated).toBe(true);
    expect(m.nodes.length).toBeLessThanOrEqual(1);
  });

  it('6. dangling edges (endpoint outside the node set) are dropped', async () => {
    await seedGraph(home);
    // limit 1 keeps 1 entity; the references edge's other endpoint is excluded -> dropped.
    const m = await buildGraphModel(sqliteStore(home).graphReads, T, { limit: 1 });
    for (const e of m.edges) {
      const ids = new Set(m.nodes.map((n) => n.id));
      expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
    }
  });

  it('15. focus query finds an entity beyond the global limit window', async () => {
    // Many entities so that a small `limit`, under the old global-cap-then-filter,
    // would miss the focus entity / its neighbor. The by-name focus query (which
    // looks up the entity directly, then its bidirectional edges) must still find it.
    await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      policyName: 'FocusPol',
      policyText: 'the focus policy',
    });
    for (let i = 0; i < 6; i++) {
      await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
        policyName: `Filler${i}`,
        policyText: 'x',
      });
    }
    await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      decisionText: 'We adopt FocusPol across every service now',
    });
    await extractGraph(sqliteStore(home), T);
    const m = await buildGraphModel(sqliteStore(home).graphReads, T, { entity: 'FocusPol', limit: 2 });
    expect(m.nodes.some((n) => n.name === 'FocusPol')).toBe(true); // found despite limit 2
    expect(m.edges.length).toBeGreaterThanOrEqual(1); // its references edge is present
    const ids = new Set(m.nodes.map((n) => n.id));
    expect(m.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true);
  });

  it('16. focus subgraph includes neighbour-to-neighbour edges, not just focus-touching', async () => {
    await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      policyName: 'PolA',
      policyText: 'PolA works closely with PolB',
    });
    await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      policyName: 'PolB',
      policyText: 'a standalone policy',
    });
    await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      decisionText: 'Adopt PolA and PolB across the org now',
    });
    await extractGraph(sqliteStore(home), T);
    const m = await buildGraphModel(sqliteStore(home).graphReads, T, {
      entity: 'Adopt PolA and PolB across the org now',
    });
    const nameById = new Map(m.nodes.map((n) => [n.id, n.name]));
    // PolA --references--> PolB connects two NEIGHBORS (neither is the focus decision);
    // it would be missing if only focus-touching edges were loaded.
    const interNeighbor = m.edges.some((e) => nameById.get(e.from) === 'PolA' && nameById.get(e.to) === 'PolB');
    expect(interNeighbor).toBe(true);
  });

  it('17. focus on a name shared by many entities is capped to the limit', async () => {
    for (let i = 0; i < 8; i++) {
      await saveCustomerNote(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
        customer: 'Acme',
        note: `note ${i}`,
      });
    }
    await extractGraph(sqliteStore(home), T);
    const m = await buildGraphModel(sqliteStore(home).graphReads, T, { entity: 'Acme', limit: 3 });
    expect(m.nodes.length).toBeLessThanOrEqual(3); // 8 same-name entities capped to 3
    expect(m.truncated).toBe(true);
  });

  it('18. focus truncation is reported when the neighbour scan hits the cap', async () => {
    for (const p of ['PolA', 'PolB', 'PolC', 'PolD']) {
      await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, { policyName: p, policyText: 'x' });
    }
    await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      decisionText: 'Adopt PolA and PolB and PolC and PolD now',
    });
    await extractGraph(sqliteStore(home), T);
    // limit 3: the decision references 4 policies; one 1-hop neighbor cannot fit,
    // so the model must report truncated (not silently omit a neighbor).
    const m = await buildGraphModel(sqliteStore(home).graphReads, T, {
      entity: 'Adopt PolA and PolB and PolC and PolD now',
      limit: 3,
    });
    expect(m.nodes.length).toBeLessThanOrEqual(3);
    expect(m.truncated).toBe(true);
  });
});

describe('graph-view: layout + renderers (pure)', () => {
  const model: GraphModel = {
    nodes: [
      { id: 1, type: 'decision', name: 'Adopt Postgres' },
      { id: 2, type: 'policy', name: 'RetryPolicy' },
      { id: 3, type: 'customer', name: 'Acme' },
    ],
    edges: [{ from: 1, to: 2, relType: 'references' }],
    truncated: false,
  };

  it('7. layout is deterministic (no Math.random): identical positions across runs', () => {
    const a = layoutGraph(model);
    const b = layoutGraph(model);
    expect([...a.entries()]).toEqual([...b.entries()]);
    for (const p of a.values()) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
  });

  it('8. layout handles 0 and 1 node without NaN', () => {
    expect(layoutGraph({ nodes: [], edges: [], truncated: false }).size).toBe(0);
    const one = layoutGraph({ nodes: [{ id: 9, type: 'system', name: 'x' }], edges: [], truncated: false });
    expect(one.size).toBe(1);
    const p = one.get(9)!;
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });

  it('9. XSS: a </script>-injecting entity name is inert in the HTML', () => {
    const evil: GraphModel = {
      nodes: [{ id: 1, type: 'policy', name: '</script><script>alert(1)</script>' }],
      edges: [],
      truncated: false,
    };
    const html = renderGraphHtml(evil);
    // No raw breakout: the literal attack string must not appear unescaped.
    expect(html).not.toContain('<script>alert(1)</script>');
    // Escaped in the SVG <title> (HTML entities) AND in the inlined JSON (<).
    expect(html).toContain('&lt;/script&gt;');
    expect(html).toContain('\\u003c/script');
  });

  it('10. HTML viewer is self-contained (no external/CDN refs) and renders the graph', () => {
    const html = renderGraphHtml(model);
    expect(html).toContain('<svg');
    expect(html).toContain('<circle');
    expect(html).toContain('id="graph-data"');
    // No external resource loads — fully offline.
    expect(html).not.toMatch(/src\s*=\s*["']https?:/i);
    expect(html).not.toMatch(/<link[^>]+href\s*=\s*["']https?:/i);
  });

  it('11. JSON Canvas export is valid and 1:1 with the model', () => {
    // SAFETY: renderGraphCanvas (src/graph/view.ts) is the function under
    // test; its output is always this JSON Canvas node/edge shape.
    const canvas = JSON.parse(renderGraphCanvas(model)) as {
      nodes: { id: string; type: string; x: number; y: number; width: number; height: number; text: string }[];
      edges: { id: string; fromNode: string; toNode: string; label: string }[];
    };
    expect(canvas.nodes).toHaveLength(model.nodes.length);
    expect(canvas.edges).toHaveLength(model.edges.length);
    for (const n of canvas.nodes) {
      expect(n.type).toBe('text');
      expect(n.x).toEqual(expect.any(Number));
      expect(n.y).toEqual(expect.any(Number));
      expect(n.text).toEqual(expect.any(String));
    }
    expect(canvas.edges[0].fromNode).toBe('n1');
    expect(canvas.edges[0].toNode).toBe('n2');
  });
});

describe('graph-view: GET /v1/graph (live server)', () => {
  let home: string;
  let globalHome: string;
  let handle: ServerHandle;

  beforeEach(async () => {
    home = makeRoot('graphview');
    globalHome = makeRoot('graphview');
    vi.stubEnv('HIPPO_HOME', globalHome);
    handle = await serve({ hippoRoot: home, port: 0 });
  });
  afterEach(async () => {
    await handle.stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(globalHome, { recursive: true, force: true });
  });

  it("12. returns the caller-tenant graph; another tenant's entities are absent", async () => {
    await seedGraph(home, T);
    // A separate tenant's graph in the same store must NOT leak to the default caller.
    await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'tenantB', {
      policyName: 'TenantBOnlyPolicy',
      policyText: 'x',
    });
    await extractGraph(sqliteStore(home), 'tenantB');

    const res = await fetch(`${handle.url}/v1/graph`);
    expect(res.status).toBe(200);
    // SAFETY: GET /v1/graph is served by this app's own route handler
    // (src/server.ts), which always sends a GraphModel-shaped JSON body.
    const body = (await res.json()) as GraphModel;
    expect(body.nodes.some((n) => n.name === 'RetryPolicy')).toBe(true);
    expect(body.nodes.some((n) => n.name === 'TenantBOnlyPolicy')).toBe(false);
  });

  it('13. fractional ?limit= is a 400 (not a SQLite datatype-mismatch 500)', async () => {
    const res = await fetch(`${handle.url}/v1/graph?limit=1.5`);
    expect(res.status).toBe(400);
  });

  it('14. empty graph returns 200 with empty nodes/edges', async () => {
    const res = await fetch(`${handle.url}/v1/graph`);
    expect(res.status).toBe(200);
    // SAFETY: GET /v1/graph is served by this app's own route handler
    // (src/server.ts), which always sends a GraphModel-shaped JSON body.
    const body = (await res.json()) as GraphModel;
    expect(body.nodes).toEqual([]);
    expect(body.edges).toEqual([]);
  });

  it('19. accepts a valid entity name longer than 256 chars', async () => {
    const longName = 'Adopt ' + 'X'.repeat(300); // ~306 chars, within MAX_ENTITY_NAME_LEN (512)
    await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, { decisionText: longName });
    await extractGraph(sqliteStore(home), T);
    const res = await fetch(`${handle.url}/v1/graph?entity=${encodeURIComponent(longName)}`);
    expect(res.status).toBe(200); // not a 400 length rejection
    // SAFETY: GET /v1/graph is served by this app's own route handler
    // (src/server.ts), which always sends a GraphModel-shaped JSON body.
    const body = (await res.json()) as GraphModel;
    expect(body.nodes.some((n) => n.name === longName)).toBe(true);
  });
});
