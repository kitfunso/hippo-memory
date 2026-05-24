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
  /** Filter-derived visible set. Empty set = no filter active. */
  visibleIds: Set<string>;
  /** The BrainScene instance, passed via ref-callback from the canvas hook. */
  scene: BrainScene | null;
  /** Max number of always-on labels (default 14). */
  topN?: number;
}

interface LabelTarget {
  id: string;
  label: string;
  layer: Memory["layer"];
  worldX: number;
  worldY: number;
  worldZ: number;
}

/**
 * Select the top-N memories worth labelling. Strength * log(1+retrievals) is
 * a rough "importance" proxy — high-strength but never-retrieved memories
 * shouldn't dominate.
 */
export function selectTopNLabels(
  memories: Memory[],
  visibleIds: Set<string>,
  topN: number,
): Memory[] {
  const filterActive = visibleIds.size > 0 && visibleIds.size < memories.length;
  const candidates = filterActive ? memories.filter((m) => visibleIds.has(m.id)) : memories;
  const scored = candidates.map((m) => ({
    m,
    score: m.strength * Math.log2(m.retrieval_count + 2),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN).map((x) => x.m);
}

/**
 * One-line label text from a memory. First line of content, truncated to 28
 * chars (with ellipsis). Tags/ids are noise at glance-distance.
 */
export function labelTextForMemory(m: Memory): string {
  const firstLine = m.content.split(/\n/)[0]?.trim() ?? "";
  if (firstLine.length <= 28) return firstLine;
  return firstLine.slice(0, 27).trimEnd() + "…";
}

export function LabelOverlay({ memories, visibleIds, scene, topN = 14 }: LabelOverlayProps) {
  // Top-N memoized: doesn't change per-frame, only when memories/visibleIds change.
  const topMemories = useMemo(
    () => selectTopNLabels(memories, visibleIds, topN),
    [memories, visibleIds, topN],
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

    const updateFn = (camera: THREE.PerspectiveCamera) => {
      // Sizing: use the scene's renderer canvas if available (more accurate
      // than reading window since the canvas is a sub-region after E3 sidebar).
      let canvasW = window.innerWidth - 340;
      let canvasH = window.innerHeight - 48;
      if (renderer) {
        const size = renderer.getSize(new THREE.Vector2());
        canvasW = size.x;
        canvasH = size.y;
      }

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
        el.style.transform = `translate(${Math.round(screenX + 12)}px, ${Math.round(screenY - 8)}px)`;
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
        position: "absolute",
        top: 48,
        left: 0,
        right: 340, // sidebar gutter
        bottom: 0,
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
