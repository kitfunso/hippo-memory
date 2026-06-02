/**
 * E3 graph observability + visualization — READ-ONLY over the entity/relation
 * graph (docs/plans/2026-06-02-graph-observability.md).
 *
 * This module only READS the graph (`loadEntities` / `loadRelations`) and renders
 * view-models; it issues no INSERT/UPDATE/DELETE, so `scripts/check-graph-writes.mjs`
 * stays green. Used by the CLI (`hippo graph show` / `hippo graph view`) and the
 * HTTP `GET /v1/graph` route, which all build the same `GraphModel`.
 */

import {
  loadEntities,
  loadEntitiesByName,
  loadEntitiesByIds,
  loadRelations,
  loadNeighborRelations,
  loadRelationsAmong,
  withGraphReadSnapshot,
  type Entity,
  type Relation,
  type EntityType,
  type RelationType,
} from './graph.js';

export interface GraphNode {
  id: number;
  type: EntityType;
  name: string;
}
export interface GraphEdge {
  from: number;
  to: number;
  relType: RelationType;
}
export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Conservative "maybe incomplete" flag: true when a loader returned exactly
   *  its limit (the graph MAY be truncated). Can over-report, never under-report. */
  truncated: boolean;
}

/** Default bound for the CLI viewer / show so an unbounded set is never laid out. */
export const DEFAULT_VIEW_LIMIT = 500;

/**
 * Build the view-model from the graph (reads only). With `opts.entity`, returns a
 * focus subgraph: every entity whose name === entity, plus their 1-hop neighbours,
 * plus the edges among that union. Dangling edges (an endpoint outside the node
 * set) are always dropped.
 */
export function buildGraphModel(
  hippoRoot: string,
  tenantId: string,
  opts: { entity?: string; limit?: number } = {},
): GraphModel {
  const limit = opts.limit ?? DEFAULT_VIEW_LIMIT;

  // All reads run inside ONE read snapshot so a concurrent `graph extract` /
  // sleep-drain rebuild can't make the model mix old entity ids with new relation
  // ids (codex P2). Every load* call below is passed the snapshot connection `db`.
  return withGraphReadSnapshot(hippoRoot, (db) => {
    let nodeEntities: Entity[];
    let relations: Relation[];
    let truncated: boolean;

    if (opts.entity !== undefined) {
      // Focus subgraph. (1) Query the named entity DIRECTLY (by name, not from a
      // globally-capped list) so it is found even on a graph larger than `limit`.
      // (2) A name can map to MANY entities (e.g. many notes for one customer), so
      // cap the focus matches. (3) Discover 1-hop neighbours and cap the UNION to
      // `limit` nodes. (4) Load ALL edges AMONG the union so neighbour-to-neighbour
      // edges that don't touch the focus are included too. (codex P2s.)
      const focus = loadEntitiesByName(hippoRoot, tenantId, opts.entity, { limit }, db);
      if (focus.length === 0) return { nodes: [], edges: [], truncated: false };
      const focusIds = focus.map((e) => e.id);
      const hop = loadNeighborRelations(hippoRoot, tenantId, focusIds, { limit }, db);
      const union = new Set<number>(focusIds);
      let neighboursCapped = false;
      for (const r of hop) {
        if (union.size >= limit) {
          neighboursCapped = true; // node cap filled before all neighbours were added
          break;
        }
        union.add(r.fromEntityId);
        union.add(r.toEntityId);
      }
      const unionIds = [...union].slice(0, limit);
      nodeEntities = loadEntitiesByIds(hippoRoot, tenantId, unionIds, db);
      // Edges AMONG the union (BOTH endpoints in the set): includes
      // neighbour-to-neighbour edges, and the LIMIT can never drop a valid in-union
      // edge in favour of out-of-union rows (codex P2).
      relations = loadRelationsAmong(hippoRoot, tenantId, unionIds, { limit }, db);
      truncated =
        focus.length >= limit ||
        hop.length >= limit || // neighbour scan capped -> a 1-hop neighbour may be omitted (codex P2)
        neighboursCapped || // node cap filled before all neighbours were consumed (codex P2)
        union.size > unionIds.length ||
        relations.length >= limit;
    } else {
      nodeEntities = loadEntities(hippoRoot, tenantId, { limit }, db);
      relations = loadRelations(hippoRoot, tenantId, { limit }, db);
      truncated = nodeEntities.length >= limit || relations.length >= limit;
    }

    const nodeIds = new Set(nodeEntities.map((e) => e.id));
    const nodes: GraphNode[] = nodeEntities.map((e) => ({
      id: e.id,
      type: e.entityType,
      name: e.name,
    }));
    const edges: GraphEdge[] = relations
      .filter((r) => nodeIds.has(r.fromEntityId) && nodeIds.has(r.toEntityId))
      .map((r) => ({ from: r.fromEntityId, to: r.toEntityId, relType: r.relType }));

    return { nodes, edges, truncated };
  });
}

const LAYOUT_W = 1000;
const LAYOUT_H = 700;

/**
 * Deterministic Fruchterman-Reingold-style force layout. Seeded circular init +
 * fixed iterations, NO `Math.random`, so the same model always yields the same
 * positions (testable, stable output). Non-finite coordinates from a degenerate
 * step are clamped to the viewport centre; all positions are clamped in-bounds.
 */
export function layoutGraph(
  model: GraphModel,
  opts: { width?: number; height?: number; iterations?: number } = {},
): Map<number, { x: number; y: number }> {
  const width = opts.width ?? LAYOUT_W;
  const height = opts.height ?? LAYOUT_H;
  const iterations = opts.iterations ?? 300;
  const cx = width / 2;
  const cy = height / 2;
  const nodes = model.nodes;
  const n = nodes.length;
  const pos = new Map<number, { x: number; y: number }>();
  if (n === 0) return pos;
  if (n === 1) {
    pos.set(nodes[0].id, { x: cx, y: cy });
    return pos;
  }

  const radius = Math.min(width, height) * 0.4;
  nodes.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / n;
    pos.set(node.id, { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
  });

  const idIndex = new Map<number, number>(nodes.map((node, i) => [node.id, i]));
  const k = Math.sqrt((width * height) / n); // ideal edge length

  for (let iter = 0; iter < iterations; iter++) {
    const disp = nodes.map(() => ({ x: 0, y: 0 }));
    // Repulsion between all pairs.
    for (let i = 0; i < n; i++) {
      const pi = pos.get(nodes[i].id)!;
      for (let j = i + 1; j < n; j++) {
        const pj = pos.get(nodes[j].id)!;
        const dx = pi.x - pj.x;
        const dy = pi.y - pj.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const rep = (k * k) / dist;
        const ux = dx / dist;
        const uy = dy / dist;
        disp[i].x += ux * rep;
        disp[i].y += uy * rep;
        disp[j].x -= ux * rep;
        disp[j].y -= uy * rep;
      }
    }
    // Attraction along edges.
    for (const e of model.edges) {
      const i = idIndex.get(e.from);
      const j = idIndex.get(e.to);
      if (i === undefined || j === undefined) continue;
      const pi = pos.get(e.from)!;
      const pj = pos.get(e.to)!;
      const dx = pi.x - pj.x;
      const dy = pi.y - pj.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const att = (dist * dist) / k;
      const ux = dx / dist;
      const uy = dy / dist;
      disp[i].x -= ux * att;
      disp[i].y -= uy * att;
      disp[j].x += ux * att;
      disp[j].y += uy * att;
    }
    // Apply with cooling; clamp.
    const temp = Math.max(1, (width / 10) * (1 - iter / iterations));
    nodes.forEach((node, i) => {
      const p = pos.get(node.id)!;
      const dl = Math.hypot(disp[i].x, disp[i].y) || 0.01;
      let nx = p.x + (disp[i].x / dl) * Math.min(dl, temp);
      let ny = p.y + (disp[i].y / dl) * Math.min(dl, temp);
      if (!Number.isFinite(nx)) nx = cx;
      if (!Number.isFinite(ny)) ny = cy;
      p.x = Math.max(20, Math.min(width - 20, nx));
      p.y = Math.max(20, Math.min(height - 20, ny));
    });
  }
  return pos;
}

/** HTML-escape for SVG text / title / markup content (XSS guard). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const NODE_COLORS: Record<string, string> = {
  decision: '#6366f1',
  policy: '#10b981',
  customer: '#f59e0b',
  project: '#ec4899',
  person: '#3b82f6',
  system: '#64748b',
};

// Client script: pan (drag bg), zoom (wheel), click-to-highlight a node's edges +
// neighbours. Reads the inlined model via JSON.parse (never innerHTML), so user
// strings never reach an HTML sink here. No template literals / `${}` so it nests
// safely inside this module's own template strings.
const CLIENT_JS = [
  "(function(){",
  "  var svg=document.getElementById('g');",
  "  var vb=svg.getAttribute('viewBox').split(' ').map(Number);",
  "  var view={x:vb[0],y:vb[1],w:vb[2],h:vb[3]};",
  "  function apply(){svg.setAttribute('viewBox',view.x+' '+view.y+' '+view.w+' '+view.h);}",
  "  var panning=false,sx=0,sy=0;",
  "  svg.addEventListener('mousedown',function(e){if(e.target.closest('.node'))return;panning=true;sx=e.clientX;sy=e.clientY;});",
  "  window.addEventListener('mouseup',function(){panning=false;});",
  "  window.addEventListener('mousemove',function(e){if(!panning)return;var r=svg.getBoundingClientRect();var k=view.w/r.width;view.x-=(e.clientX-sx)*k;view.y-=(e.clientY-sy)*k;sx=e.clientX;sy=e.clientY;apply();});",
  "  svg.addEventListener('wheel',function(e){e.preventDefault();var r=svg.getBoundingClientRect();var mx=view.x+(e.clientX-r.left)/r.width*view.w;var my=view.y+(e.clientY-r.top)/r.height*view.h;var f=e.deltaY<0?0.9:1.1;view.x=mx-(mx-view.x)*f;view.y=my-(my-view.y)*f;view.w*=f;view.h*=f;apply();},{passive:false});",
  "  var data={};try{data=JSON.parse(document.getElementById('graph-data').textContent);}catch(_){}",
  "  var adj={};(data.edges||[]).forEach(function(e){(adj[e.from]=adj[e.from]||[]).push(e.to);(adj[e.to]=adj[e.to]||[]).push(e.from);});",
  "  var active=null;",
  "  document.querySelectorAll('.node').forEach(function(g){g.addEventListener('click',function(ev){ev.stopPropagation();var id=g.getAttribute('data-id');if(active===id){clearHi();active=null;return;}active=id;highlight(id);});});",
  "  svg.addEventListener('click',function(){clearHi();active=null;});",
  "  function clearHi(){svg.classList.remove('focused');document.querySelectorAll('.hi').forEach(function(el){el.classList.remove('hi');});}",
  "  function highlight(id){clearHi();svg.classList.add('focused');var keep={};keep[id]=1;(adj[id]||[]).forEach(function(n){keep[n]=1;});document.querySelectorAll('.node').forEach(function(g){if(keep[g.getAttribute('data-id')])g.classList.add('hi');});document.querySelectorAll('.edge').forEach(function(l){if(l.getAttribute('data-from')===id||l.getAttribute('data-to')===id)l.classList.add('hi');});}",
  "})();",
].join("\n");

const STYLE = [
  "html,body{margin:0;height:100%;background:#0b1020;font-family:ui-sans-serif,system-ui,sans-serif}",
  "#g{width:100vw;height:100vh;cursor:grab}",
  "#g:active{cursor:grabbing}",
  ".edge{stroke:#475569;stroke-width:1}",
  ".node circle{stroke:#0b1020;stroke-width:1.5}",
  ".node text{fill:#e2e8f0;font-size:11px;pointer-events:none}",
  ".node{cursor:pointer}",
  "#g.focused .node{opacity:.18}",
  "#g.focused .edge{opacity:.07}",
  "#g.focused .node.hi{opacity:1}",
  "#g.focused .edge.hi{opacity:1;stroke:#e2e8f0}",
  ".legend{position:fixed;top:10px;left:12px;color:#94a3b8;font-size:12px;line-height:1.6}",
  ".legend b{color:#e2e8f0}",
].join("\n");

/**
 * Render the model as a SELF-CONTAINED, dependency-free, offline interactive HTML
 * node-link diagram. Positions are computed server-side (deterministic). User
 * strings are escaped per sink: SVG `<text>`/`<title>` via `escapeHtml`; the model
 * is inlined in a `<script type="application/json">` block with `<`/`>`/`&`
 * unicode-escaped so a `</script>` inside an entity name cannot break out (the
 * client `JSON.parse`s it back and never `innerHTML`s a user string).
 */
export function renderGraphHtml(model: GraphModel): string {
  const pos = layoutGraph(model);
  const color = (t: string): string => NODE_COLORS[t] ?? '#64748b';

  const edgeSvg = model.edges
    .map((e) => {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) return '';
      return (
        `<line class="edge" data-from="${e.from}" data-to="${e.to}" ` +
        `x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"/>`
      );
    })
    .join('');

  const nodeSvg = model.nodes
    .map((node) => {
      const p = pos.get(node.id);
      if (!p) return '';
      const label = node.name.length > 22 ? node.name.slice(0, 21) + '…' : node.name;
      return (
        `<g class="node" data-id="${node.id}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})">` +
        `<title>${escapeHtml(node.type + ': ' + node.name)}</title>` +
        `<circle r="7" fill="${color(node.type)}"/>` +
        `<text x="10" y="4">${escapeHtml(label)}</text>` +
        `</g>`
      );
    })
    .join('');

  // Safe inline JSON for the client: unicode-escape the HTML-significant chars so
  // the content cannot terminate the <script> block; JSON.parse restores them.
  const dataJson = JSON.stringify(model)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');

  const types = [...new Set(model.nodes.map((nd) => nd.type))];
  const legend = types
    .map((t) => `<span style="color:${color(t)}">●</span> ${escapeHtml(t)}`)
    .join('  ');

  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>hippo graph</title>',
    '<style>' + STYLE + '</style></head><body>',
    `<div class="legend"><b>hippo graph</b> · ${model.nodes.length} entities · ${model.edges.length} relations` +
      (model.truncated ? ' · <b style="color:#f59e0b">truncated</b>' : '') +
      `<br>${legend}<br><span style="color:#64748b">drag to pan · scroll to zoom · click a node to focus</span></div>`,
    `<svg id="g" viewBox="0 0 ${LAYOUT_W} ${LAYOUT_H}" preserveAspectRatio="xMidYMid meet">`,
    `<g id="edges">${edgeSvg}</g><g id="nodes">${nodeSvg}</g>`,
    '</svg>',
    `<script type="application/json" id="graph-data">${dataJson}</script>`,
    '<script>' + CLIENT_JS + '</script>',
    '</body></html>',
  ].join('\n');
}

/**
 * Render the model as a JSON Canvas (jsoncanvas.org) document — `nodes[]` of
 * type `text` positioned by the same deterministic layout, `edges[]` linking
 * them by id. Opens natively in Obsidian. Pure JSON; entity names live in the
 * `text` field (Obsidian renders/sanitizes them).
 */
export function renderGraphCanvas(model: GraphModel): string {
  const pos = layoutGraph(model, { width: 2400, height: 1600 });
  const nodes = model.nodes.map((node) => {
    const p = pos.get(node.id) ?? { x: 0, y: 0 };
    return {
      id: `n${node.id}`,
      type: 'text',
      x: Math.round(p.x),
      y: Math.round(p.y),
      width: 240,
      height: 60,
      text: `**${node.type}**\n${node.name}`,
    };
  });
  const edges = model.edges.map((e, i) => ({
    id: `e${i}`,
    fromNode: `n${e.from}`,
    toNode: `n${e.to}`,
    label: e.relType,
  }));
  return JSON.stringify({ nodes, edges }, null, 2);
}
