/**
 * Graph observability and visualization, READ-ONLY over the entity/relation graph (no writes, so
 * `scripts/check-graph-writes.mjs` stays green). Shared by `hippo graph show|view` and the HTTP
 * `GET /v1/graph` route, which all build the same `GraphModel`. */

import type { ScopeActor } from '../../base/scope/recall-scope.js';
import type { GraphReads, GraphRows } from '../../base/ports/store.js';
import type { EntityType, RelationType } from '../../base/ports/store/graph.js';

const DEFAULT_LAYOUT_ITERATIONS = 300;

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
  /** Conservative "maybe incomplete" flag: true when a loader returned exactly its limit (the graph MAY be truncated).
   *  Can over-report, never under-report. */
  truncated: boolean;
}

/** Default bound for the CLI viewer / show so an unbounded set is never laid out. */
export const DEFAULT_VIEW_LIMIT = 500;

/**
 * Build the view-model (reads only); with `opts.entity`, a focus subgraph of the entities named
 * so plus their 1-hop neighbors. Dangling edges (an endpoint outside the node set) are always
 * dropped. */
export async function buildGraphModel(
  graphReads: Pick<GraphReads, 'graphRows'>,
  tenantId: string,
  opts: { entity?: string; limit?: number; reader?: ScopeActor } = {},
): Promise<GraphModel> {
  const limit = opts.limit ?? DEFAULT_VIEW_LIMIT;
  return graphModelOf(
    await graphReads.graphRows(tenantId, {
      entity: opts.entity,
      limit,
      reader: opts.reader,
    }),
  );
}

/** The reply model of the rows a store read: an edge with an endpoint outside the node set is
 * dropped. */
function graphModelOf({ entities, relations, truncated }: GraphRows): GraphModel {
  const nodeIds = new Set(entities.map((e) => e.id));
  const nodes: GraphNode[] = entities.map((e) => ({
    id: e.id,
    type: e.entityType,
    name: e.name,
  }));
  const edges: GraphEdge[] = relations
    .filter((r) => nodeIds.has(r.fromEntityId) && nodeIds.has(r.toEntityId))
    .map((r) => ({
      from: r.fromEntityId,
      to: r.toEntityId,
      relType: r.relType,
    }));
  return { nodes, edges, truncated };
}

export const LAYOUT_W = 1000;
export const LAYOUT_H = 700;

type Point = { x: number; y: number };

/** Share of the shorter viewport side that the seed circle fills. */
const SEED_RADIUS_FRACTION = 0.4;
/** Stand-in for a zero length, so coincident points divide by it rather than by zero. */
const MIN_DISTANCE = 0.01;
/** Keeps nodes this many pixels off the viewport edge. */
const EDGE_MARGIN_PX = 20;

/** Distance from pj to pi and the unit vector between them, with a zero length floored at
 * MIN_DISTANCE. */
function separation(pi: Point, pj: Point) {
  const dx = pi.x - pj.x;
  const dy = pi.y - pj.y;
  const dist = Math.hypot(dx, dy) || MIN_DISTANCE;
  return { dist, ux: dx / dist, uy: dy / dist };
}

function seedCircle(nodes: GraphNode[], width: number, height: number): Map<number, Point> {
  const pos = new Map<number, Point>();
  const n = nodes.length;
  const radius = Math.min(width, height) * SEED_RADIUS_FRACTION;
  nodes.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / n;
    pos.set(node.id, {
      x: width / 2 + radius * Math.cos(angle),
      y: height / 2 + radius * Math.sin(angle),
    });
  });
  return pos;
}

/** Repulsion reaches this many ideal edge lengths; past it a pair pushes under k/2, so the grid
 * leaves it out. */
const REPULSION_REACH_K = 2;
const CELL_KEY_STRIDE = 1 << 20;

/** Node indexes by grid cell of side `reach`, each cell's list in index order. */
function gridOf(pts: readonly Point[], reach: number): Map<number, number[]> {
  const cells = new Map<number, number[]>();
  pts.forEach((p, i) => {
    const key = Math.floor(p.x / reach) * CELL_KEY_STRIDE + Math.floor(p.y / reach);
    const cell = cells.get(key);
    if (cell) cell.push(i);
    else cells.set(key, [i]);
  });
  return cells;
}

interface AddRepulsionOptions {
  readonly nodes: GraphNode[];
  readonly pos: Map<number, Point>;
  readonly disp: Point[];
  readonly k: number;
  readonly visits: { pairs: number };
}

/** Adds every pair's repulsion within the reach, reading only the 3 by 3 cells around each node;
 * `visits` counts the pairs looked at. */
function addRepulsion({ nodes, pos, disp, k, visits }: AddRepulsionOptions): void {
  const reach = REPULSION_REACH_K * k;
  const pts = nodes.map((node) => pos.get(node.id)!);
  const cells = gridOf(pts, reach);
  for (let i = 0; i < pts.length; i++) {
    const pi = pts[i];
    const cx = Math.floor(pi.x / reach);
    const cy = Math.floor(pi.y / reach);
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        for (const j of cells.get(gx * CELL_KEY_STRIDE + gy) ?? []) {
          if (j <= i) continue;
          visits.pairs++;
          repel({ pi, pj: pts[j], di: disp[i], dj: disp[j] }, k);
        }
      }
    }
  }
}

/** Two points and the displacements their repulsion adds to. */
interface RepelOptions {
  readonly pi: Point;
  readonly pj: Point;
  readonly di: Point;
  readonly dj: Point;
}

function repel({ pi, pj, di, dj }: RepelOptions, k: number): void {
  const { dist, ux, uy } = separation(pi, pj);
  if (dist >= REPULSION_REACH_K * k) return;
  const rep = (k * k) / dist;
  di.x += ux * rep;
  di.y += uy * rep;
  dj.x -= ux * rep;
  dj.y -= uy * rep;
}

interface AddAttractionOptions {
  readonly edges: GraphEdge[];
  readonly idIndex: Map<number, number>;
  readonly pos: Map<number, Point>;
  readonly disp: Point[];
  readonly k: number;
}

function addAttraction({ edges, idIndex, pos, disp, k }: AddAttractionOptions): void {
  for (const e of edges) {
    const i = idIndex.get(e.from);
    const j = idIndex.get(e.to);
    if (i === undefined || j === undefined) continue;
    const pi = pos.get(e.from)!;
    const pj = pos.get(e.to)!;
    const { dist, ux, uy } = separation(pi, pj);
    const att = (dist * dist) / k;
    disp[i].x -= ux * att;
    disp[i].y -= uy * att;
    disp[j].x += ux * att;
    disp[j].y += uy * att;
  }
}

interface DisplacementOptions {
  nodes: GraphNode[];
  pos: Map<number, Point>;
  disp: Point[];
  temp: number;
  width: number;
  height: number;
}

function applyDisplacement(options: DisplacementOptions): void {
  const { nodes, pos, disp, temp, width, height } = options;
  nodes.forEach((node, i) => {
    const p = pos.get(node.id)!;
    const dl = Math.hypot(disp[i].x, disp[i].y) || MIN_DISTANCE;
    let nx = p.x + (disp[i].x / dl) * Math.min(dl, temp);
    let ny = p.y + (disp[i].y / dl) * Math.min(dl, temp);
    if (!Number.isFinite(nx)) nx = width / 2;
    if (!Number.isFinite(ny)) ny = height / 2;
    p.x = Math.max(EDGE_MARGIN_PX, Math.min(width - EDGE_MARGIN_PX, nx));
    p.y = Math.max(EDGE_MARGIN_PX, Math.min(height - EDGE_MARGIN_PX, ny));
  });
}

/**
 * Deterministic Fruchterman-Reingold-style force layout: seeded circular init, fixed iterations,
 * no `Math.random`, so one model gives the same positions. Repulsion reaches 2k and runs on a
 * grid, so a pass costs the nodes near each node, not every pair; `opts.visits` counts the pairs
 * looked at. Non-finite coordinates are clamped to the viewport centre and all positions to the
 * bounds. */
export function layoutGraph(
  model: GraphModel,
  opts: {
    width?: number;
    height?: number;
    iterations?: number;
    visits?: { pairs: number };
  } = {},
): Map<number, { x: number; y: number }> {
  const width = opts.width ?? LAYOUT_W;
  const height = opts.height ?? LAYOUT_H;
  const iterations = opts.iterations ?? DEFAULT_LAYOUT_ITERATIONS;
  const nodes = model.nodes;
  const n = nodes.length;
  if (n === 0) return new Map();
  if (n === 1) return new Map([[nodes[0].id, { x: width / 2, y: height / 2 }]]);

  const pos = seedCircle(nodes, width, height);
  const idIndex = new Map<number, number>(nodes.map((node, i) => [node.id, i]));
  const k = Math.sqrt((width * height) / n); // ideal edge length
  const visits = opts.visits ?? { pairs: 0 };

  for (let iter = 0; iter < iterations; iter++) {
    const disp = nodes.map(() => ({ x: 0, y: 0 }));
    addRepulsion({ nodes, pos, disp, k, visits });
    addAttraction({ edges: model.edges, idIndex, pos, disp, k });
    const temp = Math.max(1, (width / 10) * (1 - iter / iterations));
    applyDisplacement({ nodes, pos, disp, temp, width, height });
  }
  return pos;
}
