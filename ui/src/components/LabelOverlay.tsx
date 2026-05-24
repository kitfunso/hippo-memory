/**
 * E4 LabelOverlay. Per-frame screen-space projection of node labels using
 * BrainScene.onRender (from E1.5).
 *
 * Design choices:
 *
 * - **Top-N only, not all-N.** 305 always-on labels is visual chaos. We show
 *   the top N strongest visible nodes (default 14). The selected node always
 *   gets a label (rendered separately). Hover labels are handled by the
 *   existing MemoryTooltip.
 * - **Direct DOM mutation, not React state.** Per-frame setState would
 *   re-render the entire tree at 60fps. Instead, we render the label divs
 *   once on prop change, store refs in a Map, and mutate `style.transform`
 *   inside the onRender callback. React never sees the per-frame updates.
 * - **Off-screen cull.** After `vector.project(camera)`, NDC range is
 *   [-1, 1] on x/y. We hide labels where `|x|>1 || |y|>1 || z>1 || z<-1`
 *   (round-3 LOW #3 fix: symmetric on all three axes — z<-1 is near-plane
 *   crossing).
 * - **Scratch Vector3.** Class-level scratch to avoid per-frame allocation
 *   in the hot path (round-2 HIGH #2 fix).
 */

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { Memory } from "../types.js";
import { LAYER_COLORS } from "../engine/types.js";
import type { BrainScene } from "../engine/scene.js";

interface LabelOverlayProps {
  /** All memories — we derive top-N visible from this. */
  memories: Memory[];
  /** Filter-derived visible set. Only meaningful when filterActive=true. */
  visibleIds: Set<string>;
  /**
   * Round-2 code-review-critic HIGH: disambiguates "no filter active" from
   * "filter matched zero rows". Without this, selectTopNLabels would treat
   * a zero-match filter as "no filter" and label all memories anyway.
   */
  filterActive: boolean;
  /** The BrainScene instance, passed via ref-callback from the canvas hook. */
  scene: BrainScene | null;
  /** Max number of always-on labels (default 14). */
  topN?: number;
}

/**
 * Select the top-N memories worth labelling. Strength * log(1+retrievals) is
 * a rough "importance" proxy — high-strength but never-retrieved memories
 * shouldn't dominate. Skips bracket-wrapped synthetic content (per round-2
 * design-critic HIGH: '[Consolidated from N related...' reads as debug).
 */
export function selectTopNLabels(
  memories: Memory[],
  visibleIds: Set<string>,
  filterActive: boolean,
  topN: number,
): Memory[] {
  const candidates = filterActive ? memories.filter((m) => visibleIds.has(m.id)) : memories;
  const scored = candidates
    .filter((m) => {
      // Skip memories whose first line starts with '[' — these are synthetic
      // bracket-wrapped tags ('[Consolidated from N related]', etc.) that
      // read as debug output when truncated mid-bracket.
      const firstLine = m.content.split(/\n/)[0]?.trim() ?? "";
      return !firstLine.startsWith("[");
    })
    .map((m) => ({
      m,
      score: m.strength * Math.log2(m.retrieval_count + 2),
    }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN).map((x) => x.m);
}

/**
 * One-line label text from a memory. First line of content, leading [...]
 * wrapper stripped, truncated to 28 chars (with ellipsis).
 */
export function labelTextForMemory(m: Memory): string {
  let firstLine = m.content.split(/\n/)[0]?.trim() ?? "";
  // Strip leading [tag] wrapper if present (round-2 design-critic HIGH).
  firstLine = firstLine.replace(/^\[[^\]]*\]\s*/, "");
  if (firstLine.length === 0) return ""; // signal: should have been filtered
  if (firstLine.length <= 28) return firstLine;
  return firstLine.slice(0, 27).trimEnd() + "…";
}

export function LabelOverlay({ memories, visibleIds, filterActive, scene, topN = 10 }: LabelOverlayProps) {
  // Top-N memoized: doesn't change per-frame, only when memories/visibleIds change.
  // (Round-2 design-critic: reduced from 14 to 10 to ease collision in dense cluster.)
  const topMemories = useMemo(
    () => selectTopNLabels(memories, visibleIds, filterActive, topN),
    [memories, visibleIds, filterActive, topN],
  );

  // DOM refs to mutate transform directly in the per-frame callback.
  const labelRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());

  // Reset the refs map when topMemories changes so stale ids don't linger.
  useEffect(() => {
    const currentIds = new Set(topMemories.map((m) => m.id));
    for (const id of labelRefs.current.keys()) {
      if (!currentIds.has(id)) labelRefs.current.delete(id);
    }
  }, [topMemories]);

  // Subscribe per-frame projection to scene.onRender.
  useEffect(() => {
    if (!scene) return;

    const scratch = new THREE.Vector3();
    const renderer = scene.getRenderer();
    const labelSize = new THREE.Vector2();

    // Reusable AABB array per-frame so we can do simple collision avoidance:
    // when two labels overlap, hide the lower-priority one (later in topMemories
    // is lower priority since selectTopNLabels sorts by score desc).
    const placed: Array<{ x: number; y: number; w: number; h: number }> = [];

    const updateFn = (camera: THREE.PerspectiveCamera) => {
      const size = renderer.getSize(labelSize);
      const canvasW = size.x;
      const canvasH = size.y;
      placed.length = 0;

      for (const m of topMemories) {
        const node = scene.getNodePosition(m.id);
        const el = labelRefs.current.get(m.id);
        if (!node || !el) continue;

        scratch.set(node.x, node.y, node.z);
        scratch.project(camera);

        // Off-screen cull (round-3 LOW #3 fix: symmetric on all 3 axes).
        if (
          Math.abs(scratch.x) > 1 ||
          Math.abs(scratch.y) > 1 ||
          scratch.z < -1 ||
          scratch.z > 1
        ) {
          el.style.opacity = "0";
          continue;
        }

        const screenX = (scratch.x * 0.5 + 0.5) * canvasW;
        const screenY = (-scratch.y * 0.5 + 0.5) * canvasH;
        const x = screenX + 12;
        const y = screenY - 8;

        // Round-2 design-critic HIGH: AABB collision avoidance — hide
        // labels that would overlap higher-priority already-placed ones.
        // getBoundingClientRect is cached on the element until next style mutation.
        const w = el.offsetWidth || 160;
        const h = el.offsetHeight || 18;
        let collides = false;
        for (const r of placed) {
          if (x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y) {
            collides = true;
            break;
          }
        }
        if (collides) {
          el.style.opacity = "0";
          continue;
        }
        placed.push({ x, y, w, h });

        el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
        el.style.opacity = "1";
      }
    };

    const unsubscribe = scene.onRender(updateFn);
    return unsubscribe;
  }, [scene, topMemories]);

  return (
    <div
      aria-hidden="true"
      style={{
        // Round-2 code-review-critic HIGH: align overlay to the map-frame
        // inset (top:48+24, left:24, right:340+24, bottom:36+24) so the
        // per-frame translate coordinates land where the canvas renders.
        // Pre-fix labels drifted ~24px upper-left of their nodes.
        position: "absolute",
        top: 48 + 24,
        left: 24,
        right: 340 + 24,
        bottom: 36 + 24,
        pointerEvents: "none",
        zIndex: 5,
        overflow: "hidden",
      }}
    >
      {topMemories.map((m) => (
        <div
          key={m.id}
          ref={(el) => {
            labelRefs.current.set(m.id, el);
          }}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            transform: "translate(-9999px, -9999px)", // hidden until first projection
            opacity: 0,
            transition: "opacity 200ms ease",
            fontFamily: "var(--font-serif)",
            fontWeight: 600,
            fontSize: 11,
            color: "var(--text)",
            background: "var(--glass-bg-strong)",
            padding: "2px 8px",
            borderRadius: 3,
            border: `1px solid var(--glass-border)`,
            boxShadow: "0 1px 3px var(--ink-shadow)",
            letterSpacing: "0.2px",
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          <span
            style={{
              display: "inline-block",
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: LAYER_COLORS[m.layer],
              marginRight: 5,
              verticalAlign: "middle",
            }}
          />
          {labelTextForMemory(m)}
        </div>
      ))}
    </div>
  );
}
