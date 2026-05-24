import { useRef, useEffect, useCallback } from "react";
import type { Memory, Conflict, EmbeddingIndex } from "../../types.js";
import { BrainScene } from "../../engine/scene.js";
import { projectTo3D } from "../../engine/projection.js";

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

  useEffect(() => {
    sceneRef.current?.resize(width, height);
  }, [width, height]);

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

  // E3 + code-review-critic HIGH #1 fix: distinguish "no filter active"
  // from "filter matches zero rows". When filterActive is false, restore
  // full visibility. When true, honor visibleIds even if empty (hides all).
  useEffect(() => {
    sceneRef.current?.setFiltered(filterActive ? visibleIds : new Set());
  }, [visibleIds, filterActive]);

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
