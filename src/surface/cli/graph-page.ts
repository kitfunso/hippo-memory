// The graph page and JSON Canvas renderers: presentation of the plain GraphModel the domain computes.

import { layoutGraph, LAYOUT_H, LAYOUT_W, type GraphModel } from '../../api/objects/graph.js';
import { GRAPH_CLIENT_SCRIPT } from './graph-page-client.js';

const NODE_LABEL_MAX_CHARS = 22;
type Point = { x: number; y: number };

/** HTML-escape for SVG text / title / markup content (XSS guard). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface NodeColorMap {
  [key: string]: string;
}

const NODE_COLORS: NodeColorMap = {
  decision: '#6366f1',
  policy: '#10b981',
  customer: '#f59e0b',
  project: '#ec4899',
  person: '#3b82f6',
  system: '#64748b',
};

const STYLE = [
  'html,body{margin:0;height:100%;background:#0b1020;font-family:ui-sans-serif,system-ui,sans-serif}',
  '#g{width:100vw;height:100vh;cursor:grab}',
  '#g:active{cursor:grabbing}',
  '.edge{stroke:#475569;stroke-width:1}',
  '.node circle{stroke:#0b1020;stroke-width:1.5}',
  '.node text{fill:#e2e8f0;font-size:11px;pointer-events:none}',
  '.node{cursor:pointer}',
  '#g.focused .node{opacity:.18}',
  '#g.focused .edge{opacity:.07}',
  '#g.focused .node.hi{opacity:1}',
  '#g.focused .edge.hi{opacity:1;stroke:#e2e8f0}',
  '.legend{position:fixed;top:10px;left:12px;color:#94a3b8;font-size:12px;line-height:1.6}',
  '.legend b{color:#e2e8f0}',
].join('\n');

const nodeColor = (t: string): string => NODE_COLORS[t] ?? '#64748b';

function renderEdgeSvg(model: GraphModel, pos: Map<number, Point>): string {
  return model.edges
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
}

function renderNodeSvg(model: GraphModel, pos: Map<number, Point>): string {
  return model.nodes
    .map((node) => {
      const p = pos.get(node.id);
      if (!p) return '';
      const label =
        node.name.length > NODE_LABEL_MAX_CHARS ? node.name.slice(0, NODE_LABEL_MAX_CHARS - 1) + '…' : node.name;
      return (
        `<g class="node" data-id="${node.id}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})">` +
        `<title>${escapeHtml(node.type + ': ' + node.name)}</title>` +
        `<circle r="7" fill="${nodeColor(node.type)}"/>` +
        `<text x="10" y="4">${escapeHtml(label)}</text>` +
        `</g>`
      );
    })
    .join('');
}

// Safe inline JSON for the client: unicode-escape the HTML-significant chars so the content cannot terminate the
// <script> block; JSON.parse restores them.
function inlineModelJson(model: GraphModel): string {
  return JSON.stringify(model).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function renderLegend(model: GraphModel): string {
  const types = [...new Set(model.nodes.map((nd) => nd.type))];
  return types.map((t) => `<span style="color:${nodeColor(t)}">●</span> ${escapeHtml(t)}`).join('  ');
}

/**
 * Render the model as a self-contained, offline interactive HTML node-link diagram with server-side deterministic
 * positions.
 * The model is inlined as `<script type="application/json">` with `<`, `>`, `&` unicode-escaped so a `</script>` in an
 * entity name cannot break out.
 */
export function renderGraphHtml(model: GraphModel): string {
  const pos = layoutGraph(model);
  const edgeSvg = renderEdgeSvg(model, pos);
  const nodeSvg = renderNodeSvg(model, pos);
  const dataJson = inlineModelJson(model);
  const legend = renderLegend(model);

  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>hippo graph</title>',
    '<style>' + STYLE + '</style></head><body>',
    `<div class="legend"><b>hippo graph</b> · ${model.nodes.length} entities · ${model.edges.length} relations` +
      (model.truncated ? ' · <b style="color:#f59e0b">truncated</b>' : '') +
      `<br>${legend}<br><span style="color:#64748b">drag to pan ` +
      `· scroll to zoom · click a node to focus</span></div>`,
    `<svg id="g" viewBox="0 0 ${LAYOUT_W} ${LAYOUT_H}" preserveAspectRatio="xMidYMid meet">`,
    `<g id="edges">${edgeSvg}</g><g id="nodes">${nodeSvg}</g>`,
    '</svg>',
    `<script type="application/json" id="graph-data">${dataJson}</script>`,
    '<script>' + GRAPH_CLIENT_SCRIPT + '</script>',
    '</body></html>',
  ].join('\n');
}

/**
 * Render the model as a JSON Canvas (jsoncanvas.org) document: `text` nodes at the same deterministic layout positions,
 * `edges[]` linking them by id.
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
