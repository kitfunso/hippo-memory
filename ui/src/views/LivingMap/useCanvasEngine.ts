import { useRef, useEffect, useCallback } from "react";
import type { Memory, Conflict, EmbeddingIndex } from "../../types.js";
import { BrainScene } from "../../engine/scene.js";
import { projectTo3D } from "../../engine/projection.js";
import type { ColorMode } from "../../state/filterState.js";

interface UseSceneOptions {
  memories: Memory[];
  embeddings: EmbeddingIndex;
  conflicts: Conflict[];
  width: number;
  height: number;
  onHover: (memory: Memory | null, x: number, y: number) => void;
  onClick: (memory: Memory | null) => void;
  searchQuery: string;
  /** E2: when true, calls scene.setReducedMotion(true) to halt animation. */
  frozen: boolean;
  /** E3: filtered visible-id set from FilterPanel. Engine hides others. */
  visibleIds: Set<string>;
  /**
   * E4 proper: is any filter active? Disambiguates "no filter, show all"
   * from "filter matched zero memories" (code-review-critic HIGH #1 fix).
   * When false, scene receives empty set = restore all. When true and
   * visibleIds is empty, scene receives empty visible set = hide all.
   */
  filterActive: boolean;
  /**
   * v0.27 — color mode for node rendering. Threaded through to
   * scene.setColorMode(). populate() also re-applies the current mode at
   * its tail, so this effect is mostly redundant on memory refresh — it
   * remains for the case where ONLY colorMode changes (user clicks the
   * ViewPanel radio).
   */
  colorMode: ColorMode;
  /** E4 marquee: callback fires when the scene is constructed (and again
   * with null on unmount). LabelOverlay subscribes via this. */
  onSceneReady?: (scene: BrainScene | null) => void;
}

export function useCanvasEngine({
  memories,
  embeddings,
  conflicts,
  width,
  height,
  onHover,
  onClick,
  searchQuery,
  frozen,
  visibleIds,
  filterActive,
  colorMode,
  onSceneReady,
}: UseSceneOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<BrainScene | null>(null);
  const onHoverRef = useRef(onHover);
  const onClickRef = useRef(onClick);
  onHoverRef.current = onHover;
  onClickRef.current = onClick;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const scene = new BrainScene(el);
    scene.setCallbacks(
      (mem, x, y) => onHoverRef.current(mem, x, y),
      (mem) => onClickRef.current(mem),
    );
    sceneRef.current = scene;
    // E4 marquee: notify the LabelOverlay so it can subscribe per-frame.
    onSceneReady?.(scene);

    return () => {
      onSceneReady?.(null);
      scene.dispose();
      sceneRef.current = null;
    };
    // onSceneReady intentionally omitted; if it changes the scene shouldn't
    // be recreated. Caller passes a stable setState dispatcher.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || memories.length === 0) return;

    const positions = projectTo3D(embeddings);
    scene.populate(memories, positions, conflicts);
  }, [memories, embeddings, conflicts]);

  // Round-2 code-review-critic HIGH: observe the actual canvas container
  // (which lives inside the map-frame post-E4), not the outer wrapper. The
  // wrapper-based prop sizing overflowed by ~24px on all sides + 48 top
  // + 36 bottom, giving the camera the wrong aspect ratio.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const apply = () => {
      const w = Math.floor(el.clientWidth);
      const h = Math.floor(el.clientHeight);
      if (w > 0 && h > 0) sceneRef.current?.resize(w, h);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // The width/height props are now ignored (kept for backward-compat with
  // existing callers; can be deprecated in a follow-up).
  void width; void height;

  useEffect(() => {
    if (!searchQuery.trim()) {
      sceneRef.current?.clearHighlight();
      return;
    }
    const q = searchQuery.toLowerCase();
    const ids = new Set<string>();
    for (const m of memories) {
      if (m.content.toLowerCase().includes(q) || m.tags.some((t) => t.toLowerCase().includes(q))) {
        ids.add(m.id);
      }
    }
    sceneRef.current?.setHighlighted(ids);
  }, [searchQuery, memories]);

  // E2: drive scene freeze/resume from the FilterState.frozen flag.
  useEffect(() => {
    sceneRef.current?.setReducedMotion(frozen);
  }, [frozen]);

  // E3 + code-review-critic HIGH #1 fix (round 2): pass filterActive through
  // to the engine so scene/canvas honors the same "filter matched zero"
  // state the React UI shows. Round-1 fix was incomplete — the React layer
  // disambiguated but scene.setFiltered re-coalesced via its own size gate.
  useEffect(() => {
    sceneRef.current?.setFiltered(visibleIds, filterActive);
  }, [visibleIds, filterActive]);

  // v0.27 color-by-tag: drive scene.setColorMode from filterState.colorMode.
  // populate() also re-applies the current mode at its tail (single source
  // of truth for the populate-vs-setColorMode race fix), so this effect
  // handles ONLY pure mode-change events (user toggles ViewPanel radio).
  // Memory refreshes go through populate's tail call — no need to listen on
  // `memories` here too (code-review-critic R1 LOW: removes a redundant
  // setColorMode call per memory refresh).
  useEffect(() => {
    sceneRef.current?.setColorMode(colorMode, memories);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorMode]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    sceneRef.current?.handleMouseMove(e.nativeEvent);
  }, []);

  const handleClick = useCallback(() => {
    sceneRef.current?.handleClick();
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") sceneRef.current?.deselect();
  }, []);

  return { containerRef, handleMouseMove, handleClick, handleKeyDown };
}
