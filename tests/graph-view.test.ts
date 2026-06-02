/**
 * E3 graph observability + visualization - tests.
 * Docs: docs/plans/2026-06-02-graph-observability.md
 *
 * READ-ONLY over the graph: buildGraphModel (loadEntities/loadRelations), the
 * deterministic layout, the self-contained HTML viewer (XSS-escaped), the JSON
 * Canvas export, and the GET /v1/graph route. Real SQLite, no mocks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { saveDecision } from '../src/decisions.js';
import { savePolicy } from '../src/policies.js';
import { saveCustomerNote } from '../src/customer-notes.js';
import { extractGraph } from '../src/graph-extract.js';
import {
  buildGraphModel,
  layoutGraph,
  renderGraphHtml,
  renderGraphCanvas,
  type GraphModel,
} from '../src/graph-view.js';
import { serve, type ServerHandle } from '../src/server.js';

const T = 'default';

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-graphview-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}
/** Seed: a policy + a decision that names it -> 2 entities + 1 `references` edge. */
function seedGraph(home: string, tenant = T): void {
  savePolicy(home, tenant, { policyName: 'RetryPolicy', policyText: 'retry up to 3x' });
  saveDecision(home, tenant, { decisionText: 'We adopt RetryPolicy across all services' });
  extractGraph(home, tenant);
}

describe('graph-view: buildGraphModel (real DB)', () => {
  let home: string;
  beforeEach(() => { home = makeRoot(); });
  afterEach(() => { try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('1. maps entities -> nodes and relations -> edges', () => {
    seedGraph(home);
    const m = buildGraphModel(home, T);
    expect(m.nodes).toHaveLength(2);
    expect(m.nodes.some((n) => n.type === 'policy' && n.name === 'RetryPolicy')).toBe(true);
    expect(m.nodes.some((n) => n.type === 'decision')).toBe(true);
    expect(m.edges).toHaveLength(1);
    expect(m.edges[0].relType).toBe('references');
    expect(m.truncated).toBe(false);
  });

  it('2. --entity focus returns the match + its 1-hop neighbours + edges among them', () => {
    seedGraph(home);
    const m = buildGraphModel(home, T, { entity: 'RetryPolicy' });
    // RetryPolicy + the decision that references it.
    expect(m.nodes).toHaveLength(2);
    expect(m.nodes.some((n) => n.name === 'RetryPolicy')).toBe(true);
    expect(m.edges).toHaveLength(1);
  });

  it('3. unknown --entity yields an empty model', () => {
    seedGraph(home);
    const m = buildGraphModel(home, T, { entity: 'NoSuchThing' });
    expect(m.nodes).toHaveLength(0);
    expect(m.edges).toHaveLength(0);
  });

  it('4. empty store -> empty model, truncated false', () => {
    const m = buildGraphModel(home, T);
    expect(m).toEqual({ nodes: [], edges: [], truncated: false });
  });

  it('5. truncated flag set when a loader hits its limit', () => {
    seedGraph(home);
    const m = buildGraphModel(home, T, { limit: 1 }); // 2 entities, limit 1 -> truncated
    expect(m.truncated).toBe(true);
    expect(m.nodes.length).toBeLessThanOrEqual(1);
  });

  it('6. dangling edges (endpoint outside the node set) are dropped', () => {
    seedGraph(home);
    // limit 1 keeps 1 entity; the references edge's other endpoint is excluded -> dropped.
    const m = buildGraphModel(home, T, { limit: 1 });
    for (const e of m.edges) {
      const ids = new Set(m.nodes.map((n) => n.id));
      expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
    }
  });

  it('15. focus query finds an entity beyond the global limit window (codex P2)', () => {
    // Many entities so that a small `limit`, under the old global-cap-then-filter,
    // would miss the focus entity / its neighbour. The by-name focus query (which
    // looks up the entity directly, then its bidirectional edges) must still find it.
    savePolicy(home, T, { policyName: 'FocusPol', policyText: 'the focus policy' });
    for (let i = 0; i < 6; i++) savePolicy(home, T, { policyName: `Filler${i}`, policyText: 'x' });
    saveDecision(home, T, { decisionText: 'We adopt FocusPol across every service now' });
    extractGraph(home, T);
    const m = buildGraphModel(home, T, { entity: 'FocusPol', limit: 2 });
    expect(m.nodes.some((n) => n.name === 'FocusPol')).toBe(true); // found despite limit 2
    expect(m.edges.length).toBeGreaterThanOrEqual(1); // its references edge is present
    const ids = new Set(m.nodes.map((n) => n.id));
    expect(m.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true);
  });

  it('16. focus subgraph includes neighbour-to-neighbour edges, not just focus-touching (codex P2)', () => {
    savePolicy(home, T, { policyName: 'PolA', policyText: 'PolA works closely with PolB' });
    savePolicy(home, T, { policyName: 'PolB', policyText: 'a standalone policy' });
    saveDecision(home, T, { decisionText: 'Adopt PolA and PolB across the org now' });
    extractGraph(home, T);
    const m = buildGraphModel(home, T, { entity: 'Adopt PolA and PolB across the org now' });
    const nameById = new Map(m.nodes.map((n) => [n.id, n.name]));
    // PolA --references--> PolB connects two NEIGHBOURS (neither is the focus decision);
    // it would be missing if only focus-touching edges were loaded.
    const interNeighbour = m.edges.some(
      (e) => nameById.get(e.from) === 'PolA' && nameById.get(e.to) === 'PolB',
    );
    expect(interNeighbour).toBe(true);
  });

  it('17. focus on a name shared by many entities is capped to the limit (codex P2)', () => {
    for (let i = 0; i < 8; i++) saveCustomerNote(home, T, { customer: 'Acme', note: `note ${i}` });
    extractGraph(home, T);
    const m = buildGraphModel(home, T, { entity: 'Acme', limit: 3 });
    expect(m.nodes.length).toBeLessThanOrEqual(3); // 8 same-name entities capped to 3
    expect(m.truncated).toBe(true);
  });

  it('18. focus truncation is reported when the neighbour scan hits the cap (codex P2)', () => {
    for (const p of ['PolA', 'PolB', 'PolC', 'PolD']) savePolicy(home, T, { policyName: p, policyText: 'x' });
    saveDecision(home, T, { decisionText: 'Adopt PolA and PolB and PolC and PolD now' });
    extractGraph(home, T);
    // limit 3: the decision references 4 policies; one 1-hop neighbour cannot fit,
    // so the model must report truncated (not silently omit a neighbour).
    const m = buildGraphModel(home, T, { entity: 'Adopt PolA and PolB and PolC and PolD now', limit: 3 });
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
    const canvas = JSON.parse(renderGraphCanvas(model)) as {
      nodes: { id: string; type: string; x: number; y: number; width: number; height: number; text: string }[];
      edges: { id: string; fromNode: string; toNode: string; label: string }[];
    };
    expect(canvas.nodes).toHaveLength(model.nodes.length);
    expect(canvas.edges).toHaveLength(model.edges.length);
    for (const n of canvas.nodes) {
      expect(n.type).toBe('text');
      expect(typeof n.x === 'number' && typeof n.y === 'number').toBe(true);
      expect(typeof n.text).toBe('string');
    }
    expect(canvas.edges[0].fromNode).toBe('n1');
    expect(canvas.edges[0].toNode).toBe('n2');
  });
});

describe('graph-view: GET /v1/graph (live server)', () => {
  let home: string;
  let globalHome: string;
  let origHippoHome: string | undefined;
  let handle: ServerHandle;

  beforeEach(async () => {
    home = makeRoot();
    globalHome = makeRoot();
    origHippoHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = globalHome;
    handle = await serve({ hippoRoot: home, port: 0 });
  });
  afterEach(async () => {
    await handle.stop();
    if (origHippoHome === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = origHippoHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(globalHome, { recursive: true, force: true });
  });

  it('12. returns the caller-tenant graph; another tenant\'s entities are absent', async () => {
    seedGraph(home, T);
    // A separate tenant's graph in the same store must NOT leak to the default caller.
    savePolicy(home, 'tenantB', { policyName: 'TenantBOnlyPolicy', policyText: 'x' });
    extractGraph(home, 'tenantB');

    const res = await fetch(`${handle.url}/v1/graph`);
    expect(res.status).toBe(200);
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
    const body = (await res.json()) as GraphModel;
    expect(body.nodes).toEqual([]);
    expect(body.edges).toEqual([]);
  });

  it('19. accepts a valid entity name longer than 256 chars (codex P2)', async () => {
    const longName = 'Adopt ' + 'X'.repeat(300); // ~306 chars, within MAX_ENTITY_NAME_LEN (512)
    saveDecision(home, T, { decisionText: longName });
    extractGraph(home, T);
    const res = await fetch(`${handle.url}/v1/graph?entity=${encodeURIComponent(longName)}`);
    expect(res.status).toBe(200); // not a 400 length rejection
    const body = (await res.json()) as GraphModel;
    expect(body.nodes.some((n) => n.name === longName)).toBe(true);
  });
});
