# Graph observability + visualization

- Date: 2026-06-02
- Episode: 01KT4V9ZS1QAYZMY091FFFHECW (/dev-framework-rl, backend)
- Status: Draft (not yet engineering-reviewed)

## Problem

hippo's E3 graph (`entities`/`relations`) is **headless**: the only surfaces are
`hippo graph extract` (rebuild) and inline `[graph: Nhop rel]` recall
annotations. There is no way to **inspect** the entities/relations or to **see**
the graph. The data + typed structure are there; there's no viewer.

## Goal (all READ-ONLY — no graph writes; E3.3 lint stays green)

1. **Inspect (CLI):** `hippo graph show [--entity NAME] [--json]` — dump entities
   (grouped by type) + their edges, as text or JSON.
2. **Inspect (HTTP):** `GET /v1/graph [?entity=NAME&limit=N]` — the tenant's graph
   as JSON, tenant-scoped + auth-gated like sibling read routes.
3. **Visualize:** `hippo graph view [--out FILE] [--open] [--format html|canvas]
   [--entity NAME]` — generate a **self-contained, dependency-free, offline,
   interactive** HTML node-link diagram (default), or a JSON Canvas export that
   opens in Obsidian.

## Design

### New module `src/graph-view.ts` (pure, no DB writes, fully testable)

The shared core, so CLI + HTTP + viewer all build the same view-model.

```ts
export interface GraphNode { id: number; type: EntityType; name: string; }
export interface GraphEdge { from: number; to: number; relType: RelationType; }
export interface GraphModel { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean; }

/** Build the view-model from the graph (loadEntities + loadRelations — reads only).
 *  --entity NAME → a focus subgraph: that entity + its 1-hop neighbours + the
 *  edges among them. Drops dangling edges (endpoint not in the node set). */
export function buildGraphModel(hippoRoot, tenantId, opts?: { entity?: string; limit?: number }): GraphModel;

/** Deterministic force-directed layout (seeded circular init + N fixed relaxation
 *  iterations; NO Math.random → reproducible positions for tests). */
export function layoutGraph(model: GraphModel, opts?: { width; height; iterations }): Map<number, {x;y}>;

/** Self-contained HTML: inlined positioned SVG (<circle>/<line>/<text>, ALL user
 *  strings HTML-escaped) + a small <script> for pan / zoom / hover-tooltip /
 *  click-to-highlight-neighbours. No external/CDN deps; opens in any browser offline. */
export function renderGraphHtml(model: GraphModel): string;

/** JSON Canvas (jsoncanvas.org): nodes[] {id,x,y,width,height,type:'text',text} +
 *  edges[] {id,fromNode,toNode,label}. Opens natively in Obsidian. */
export function renderGraphCanvas(model: GraphModel): string;

function escapeHtml(s: string): string; // &<>"' → entities (XSS guard, grill)
```

**XSS (grill):** entity `name` is USER data (decision text, policy names). Every
user string embedded in the HTML/SVG/inlined-JSON is `escapeHtml`'d. The inlined
model JSON is emitted via `JSON.stringify` then `<`/`>`/`&` escaped so it can't
break out of the `<script>`/SVG context. Test asserts a `<script>`-containing
entity name is inert in the output.

**Layout server-side in TS** (not a client physics sim): deterministic, testable,
and keeps the client JS tiny (pan/zoom/hover/highlight only — no client-side
simulation). Positions are fixed at generation time.

### Grill-hardened constraints

- **XSS — escape per embedding context (not one blanket pass).** Three distinct
  sinks, each escaped correctly: (a) SVG `<text>` / `<title>` content →
  `escapeHtml` (`& < > " '`); (b) the model inlined for the client script →
  emitted in a `<script type="application/json" id="graph-data">…</script>` block
  with `JSON.stringify` then `<` and `&` replaced by `<`/`&` (or `&lt;`)
  so a `</script>` inside an entity name cannot break out; the client reads/parses
  that block, never `innerHTML`. (c) No user string is ever placed in an inline
  event handler or an unquoted attribute. Test: an entity named
  `</script><script>alert(1)</script>` is inert in the output.
- **Layout edge cases:** 0 nodes → empty `<svg>`; 1 node → centred; disconnected
  components are allowed to drift apart; clamp any non-finite coordinate
  (NaN/Infinity from a degenerate force step) to the viewport centre so the SVG is
  always valid.
- **`--entity NAME` semantics:** exact-name match. 0 matches → empty model + a
  `truncated:false` note ("no entity named NAME"); ≥1 matches → all matching
  entities + their 1-hop neighbours + edges among the union.
- **Limit / truncation:** `loadEntities`/`loadRelations` are each `limit`-bounded
  (default 100); `buildGraphModel` drops edges whose endpoint is not in the node
  set (dangling), and sets `truncated:true` when either loader returns exactly
  `limit` rows (the graph may be incomplete). This is a conservative "maybe
  incomplete" flag: it can over-report (exactly `limit` rows that happen to be the
  complete set) but never under-report. `graph show`/`/v1/graph` surface
  `truncated` so the cap is never silent.

### CLI (`cli.ts` `cmdGraph`, extend the `subcommand` switch — currently only `extract`)

- `graph show [--entity NAME] [--json]`: `buildGraphModel` → text (entities by
  type, then `from --[relType]--> to` edges) or `--json` (the GraphModel).
- `graph view [--out FILE] [--open] [--format html|canvas] [--entity NAME]`:
  build → render (html default | canvas) → write FILE (default
  `hippo-graph.html` / `hippo-graph.canvas`) → `--open` launches the OS browser
  (`start`/`open`/`xdg-open` by platform; best-effort, never fails the command).

New flags `--entity/--out/--open/--format/--json` are all single/boolean — NOT
repeatable, so the `parseArgs` repeatable-flag allow-list is untouched.
`cmdGraph`'s third param is currently `_flags` (unused) — rename it to `flags` to
read these. Both `show` and `view` apply a **default limit (500)** when
`--limit`/`--entity` is unset, so the viewer never lays out an unbounded set
(`loadEntities`/`loadRelations` default to only 100 each — the CLI passes an
explicit bound).

### HTTP (`server.ts`, register `GET /v1/graph` in the route chain)

Mirror `GET /v1/memories` (server.ts:683): `const ctx = buildContextWithAuth(req,
opts.hippoRoot)` (tenant-scoped, loopback-no-auth=admin, /v1/ rate-limited) →
`buildGraphModel(ctx.hippoRoot, ctx.tenantId, {entity, limit})` →
`sendJson(res, 200, model)`. **Limit validation REUSES the existing shared
`parseListLimit` helper (server.ts:264)** — it already implements the
`Number.isInteger` guard (default 100, cap 1000, the 400 message) and its comment
documents the exact sibling bug (codex 2026-05-30 P2: a fractional `?limit=` →
node:sqlite datatype-mismatch 500 on the policy route). Do NOT reinvent an inline
check — reuse the helper so the guard can't drift (this is the sibling-clone
audit rule). `?entity=` is length-capped (256) like sibling id params.

## New / changed surface

- `src/graph-view.ts` — NEW (buildGraphModel, layoutGraph, renderGraphHtml, renderGraphCanvas, escapeHtml).
- `src/cli.ts` — `cmdGraph`: add `show` + `view` subcommands; help text; usage.
- `src/server.ts` — add `GET /v1/graph`.
- **No migration. No graph writes** (only `loadEntities`/`loadRelations` reads).

## Test plan (real SQLite, temp dirs, no mocks)

New `tests/graph-view.test.ts`:
1. `buildGraphModel`: N entities → N nodes (id/type/name), M relations → M edges (from/to/relType).
2. `--entity NAME` focus: returns that entity + its 1-hop neighbours + only edges among them; dangling edges dropped.
3. Empty graph → `{nodes:[], edges:[]}`.
4. `layoutGraph` deterministic: same model → identical positions across two runs (no Math.random).
5. **XSS:** an entity named `<script>alert(1)</script>` (and one with `&"'`) appears HTML-escaped in `renderGraphHtml` output (no raw `<script>` tag; `&lt;script&gt;`).
6. `renderGraphHtml`: self-contained (no `http`/`src=` external refs; contains the inlined model + a `<svg>` with a `<circle>` per node).
7. `renderGraphCanvas`: parses as JSON; `nodes.length === model.nodes.length`, `edges.length === model.edges.length`; node shape `{id,type:'text',x,y,width,height,text}`.
8. CLI `graph show`: text output lists entity names by type; `--json` emits the GraphModel.
9. `/v1/graph`: tenant-scoped — tenant A's request returns only A's graph (B's entities absent).
10. `/v1/graph` limit validation: `?limit=1.5` → 400; `?limit=2` → 200 with ≤2 nodes.
11. `/v1/graph` empty graph → 200 `{nodes:[],edges:[]}`.
12. `graph view --format canvas` writes a `.canvas` file that parses as JSON Canvas.

Plus: `scripts/check-graph-writes.mjs` green (NO graph writes added); full `npm test` green; `tsc` build clean.

## Out of scope (explicit)

- A LIVE served web view (`hippo serve` → `/graph` page) — the generated HTML file
  is the proportionate first slice; a served interactive page is a follow-up.
- A website/frontend visualization — REJECTED: the graph is LOCAL per-user SQLite;
  a marketing site has no access to it.
- Client-side physics / drag-to-rearrange — the layout is computed server-side
  (deterministic). Pan/zoom/hover/highlight is the interactivity; drag-rearrange
  is a follow-up.
- Large-graph scaling: `--entity` focus + `limit` bound the rendered set; a very
  large full graph renders but may be cluttered (documented, not solved here).

## Disposition

Read-only observability + a self-contained viewer over an existing substrate.
Minor version bump (new commands + route + viewer). No migration, no graph writes.
