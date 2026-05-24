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

    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

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
