# Graph observability + visualization — verify result (DESCRIPTIVE)

- Date: 2026-06-02
- Episode: 01KT4V9ZS1QAYZMY091FFFHECW (/dev-framework-rl, backend)
- Feature: read-only graph observability — `hippo graph show` (CLI), `GET /v1/graph`
  (HTTP), and `hippo graph view` (a self-contained interactive HTML node-link
  diagram + JSON Canvas export) over the E3 entity/relation graph.

Correctness is structural (the model equals the graph; the viewer is valid + safe)
and there is no graph mutation, so no behavioural metric — just runtime evidence.

## Runtime evidence

| check | result |
|---|---|
| `tests/graph-view.test.ts` (new) | **14/14 pass** (real SQLite) |
| full suite `npx vitest run` | **2461 pass / 4 skip / 1 fail** |
| the 1 failure | `server-concurrency.test.ts` `ECONNRESET` under full-suite load — the known environmental flake; **passes in isolation**; zero references to this diff |
| `scripts/check-graph-writes.mjs` | **green** — read-only; `graph-view.ts` uses only `loadEntities`/`loadRelations` |
| `npm run build` (tsc + benchmarks tsc) | **clean** |

## End-to-end CLI smoke (temp store)

`hippo init` → `hippo decide "…RetryPolicy…"` → `hippo graph extract` →

- `hippo graph show` →
  ```
  Graph: 1 entities, 0 relations

  decision (1):
    [1] We adopt RetryPolicy across all services
  ```
- `hippo graph view --out g.html` → wrote a **3603-byte self-contained HTML** file
  beginning `<svg id="g" viewBox="0 0 1000 700" preserveAspectRatio="xMidYMid meet">`
  — a valid, offline, dependency-free node-link diagram.

## What the 14 tests lock

1-6 `buildGraphModel`: entities→nodes / relations→edges; `--entity` focus subgraph;
unknown entity → empty; empty store → empty; `truncated` flag on limit; dangling
edges dropped. 7-8 `layoutGraph` deterministic (no `Math.random`) + 0/1-node
without NaN. 9 **XSS**: a `</script>`-injecting entity name is inert in the HTML
(escaped in the SVG `<title>` and unicode-escaped in the inlined JSON). 10 viewer
self-contained (no external/CDN refs). 11 JSON Canvas valid + 1:1 with the model.
12 `/v1/graph` tenant-scoped (another tenant's entities absent). 13 fractional
`?limit=1.5` → 400 (reuses `parseListLimit`). 14 empty graph → 200 `{nodes:[],edges:[]}`.

## Notes / honest caveats

- **Read-only.** No graph writes added; `check-graph-writes` stays green. The
  graph is rebuilt only by the existing `hippo graph extract` / sleep hook.
- **Layout** is a deterministic server-side force layout (testable, stable). Pan /
  zoom / hover (native SVG `<title>`) / click-to-highlight are the interactivity;
  client-side drag-rearrange and a live-served `/graph` page are documented
  follow-ups.
- **Large graphs:** `--entity` focus + the default 500 limit bound the rendered
  set; a very large full graph renders but may be cluttered (`truncated` is
  surfaced, conservative — may over-report, never under-report).

## Cross-model review (codex `review --commit`)

Codex ran **7 rounds** and caught a P1 + 8 P2s on the focus-subgraph / read path
that all three Claude critics missed. All fixed + regression-tested:

1. **Focus entity beyond the global cap.** `--entity` filtered a globally-capped
   list, so a focus query on a graph larger than `limit` falsely reported "no such
   entity". Fixed with a direct by-name lookup (`loadEntitiesByName`). (test #15)
2. **Duplicate-name focus uncapped** + **missing neighbour-to-neighbour edges.**
   A name mapping to many entities blew past the cap; only focus-touching edges
   were loaded. Fixed: cap the focus + union, and load edges AMONG the union
   (`loadRelationsAmong`, both endpoints in the set). (tests #16, #17)
3. **Limit pushed into SQL.** `loadEntitiesByName` now caps in SQL (no
   materializing every same-name row).
4. **Truncation under-reporting (×2).** A capped neighbour scan / an early union
   break could omit a neighbour while reporting `truncated:false`. Fixed by adding
   `hop.length >= limit` and an early-break flag. (test #18)
5. **HTTP entity-name cap.** The route capped `?entity=` at the id-shaped 256, but
   entity names are valid to 512; aligned to `MAX_ENTITY_NAME_LEN`. (test #19)
6. **Single read snapshot.** The 2–4 loader reads weren't one snapshot, so a
   concurrent rebuild could mix old entity ids with new relation ids. Fixed:
   `withGraphReadSnapshot` threads one connection (one WAL read transaction)
   through all six graph read loaders, so the whole model is built from one
   consistent snapshot.

Round 7 clean: "no discrete correctness, security, or blocking maintainability
issues; the graph read/model/render paths are bounded, tenant-scoped, build cleanly."
