import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { Memory, Conflict, Stats, EmbeddingIndex } from "../../types.js";
import { useCanvasEngine } from "./useCanvasEngine.js";
import { MemoryTooltip } from "../../components/MemoryTooltip.js";
import { Header } from "../../components/Header.js";
import { Sidebar } from "../../components/Sidebar.js";
import { BottomBar } from "../../components/BottomBar.js";
import { LabelOverlay } from "../../components/LabelOverlay.js";
import { Drawer } from "../../components/Drawer.js";
import { SkipLink } from "../../components/SkipLink.js";
import { LAYER_COLORS } from "../../engine/types.js";
import {
  deriveVisibleIds,
  isFilterActive,
  matchesQuery,
  type FilterState,
  type Layer,
  type Confidence,
} from "../../state/filterState.js";
import type { BrainScene } from "../../engine/scene.js";

interface LivingMapProps {
  memories: Memory[];
  embeddings: EmbeddingIndex;
  stats: Stats | null;
  conflicts: Conflict[];
  filterState: FilterState;
  /** E5 S6: OS vs user origin of the current freeze. */
  frozenOrigin: "os" | "user" | null;
  setQuery: (query: string) => void;
  setFrozen: (frozen: boolean) => void;
  setLayers: (layers: Set<Layer>) => void;
  setStrengthRange: (range: [number, number]) => void;
  setConfidences: (confidences: Set<Confidence>) => void;
  setAgeMaxDays: (days: number | null) => void;
  resetFilters: () => void;
}

function StrengthBar({ value }: { value: number }) {
  return (
    <div style={{ width: "100%", height: 3, background: "var(--glass-border)", borderRadius: 2, overflow: "hidden" }}>
      <div style={{
        width: `${value * 100}%`, height: "100%", borderRadius: 2,
        background: `linear-gradient(90deg, var(--accent), ${value > 0.5 ? "var(--green)" : "var(--yellow)"})`,
      }} />
    </div>
  );
}

function DetailPanel({ memory, onClose, open }: { memory: Memory | null; onClose: () => void; open: boolean }) {
  if (!memory && !open) return null;
  const layerColor = memory ? LAYER_COLORS[memory.layer] : "var(--accent)";

  return (
    <div role="dialog" aria-label="Memory details" style={{
      position: "absolute", top: 0, right: 0, width: "min(360px, 48vw)", height: "100%",
      background: "var(--glass-bg-strong)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)",
      borderLeft: "1px solid var(--glass-border)", overflowY: "auto", zIndex: 50,
      transform: open ? "translateX(0)" : "translateX(100%)",
      transition: "transform 250ms cubic-bezier(0.16, 1, 0.3, 1)",
    }}>
      {memory && (
        <>
          <div style={{
            padding: "20px 24px 16px", borderBottom: "1px solid var(--glass-border)",
            display: "flex", justifyContent: "space-between", alignItems: "flex-start",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: layerColor, boxShadow: `0 0 8px ${layerColor}40` }} />
              <span style={{ color: "var(--dim)", fontSize: 10, fontFamily: "var(--font-mono)", letterSpacing: "0.5px", textTransform: "uppercase" }}>{memory.layer}</span>
            </div>
            <button onClick={onClose} style={{
              background: "var(--ink-faint)", border: "none", borderRadius: 4,
              color: "var(--dim)", cursor: "pointer", padding: "4px 10px", fontSize: 11, fontFamily: "var(--font-mono)",
            }}>esc</button>
          </div>
          <div style={{ padding: "20px 24px" }}>
            <div style={{ color: "var(--text)", fontSize: 13, lineHeight: 1.7, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-body)", marginBottom: 20 }}>
              {memory.content}
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ color: "var(--dim)", fontSize: 10, fontFamily: "var(--font-mono)" }}>STRENGTH</span>
                <span style={{ color: "var(--text)", fontSize: 11, fontFamily: "var(--font-mono)" }}>{memory.strength.toFixed(3)}</span>
              </div>
              <StrengthBar value={memory.strength} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 20px", fontSize: 11, marginBottom: 20 }}>
              {([
                ["Half-life", `${memory.half_life_days}d`], ["Retrievals", String(memory.retrieval_count)],
                ["Age", `${memory.age_days}d`], ["Schema fit", memory.schema_fit.toFixed(2)],
                ["Valence", memory.emotional_valence], ["Confidence", memory.confidence],
                ["+7d", memory.projected_strength_7d.toFixed(3)], ["+30d", memory.projected_strength_30d.toFixed(3)],
              ] as [string, string][]).map(([label, val]) => (
                <div key={label}>
                  <div style={{ color: "var(--dim)", fontSize: 9, fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 2 }}>{label}</div>
                  <div style={{ color: "var(--text)", fontFamily: "var(--font-mono)" }}>{val}</div>
                </div>
              ))}
            </div>
            {memory.tags.length > 0 && (
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 16 }}>
                {memory.tags.map((tag) => (
                  <span key={tag} style={{ background: "var(--ink-faint)", color: "var(--dim)", padding: "3px 10px", borderRadius: 12, fontSize: 10, fontFamily: "var(--font-mono)" }}>{tag}</span>
                ))}
              </div>
            )}
            <div style={{ fontSize: 10, color: "var(--text-faint)", fontFamily: "var(--font-mono)", borderTop: "1px solid var(--glass-border)", paddingTop: 12 }}>
              <div>{memory.id}</div>
              <div style={{ marginTop: 4 }}>{new Date(memory.created).toLocaleDateString()} &rarr; {new Date(memory.last_retrieved).toLocaleDateString()}</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function LivingMap({
  memories, embeddings, stats, conflicts, filterState, frozenOrigin,
  setQuery, setFrozen, setLayers, setStrengthRange, setConfidences, setAgeMaxDays,
  resetFilters,
}: LivingMapProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hoveredMemory, setHoveredMemory] = useState<{ memory: Memory; x: number; y: number } | null>(null);
  const [selectedMemory, setSelectedMemory] = useState<Memory | null>(null);
  // E5 S1: transient UI state for the drawer mirror. Lives here, NOT in
  // FilterState (FilterState is for data filters, not viewport chrome).
  const [drawerOpen, setDrawerOpen] = useState(false);

  // E3: derive the visible-id set once per render so Sidebar (tag cloud +
  // stats) and the scene filter wiring share the same source of truth.
  const visibleIds = useMemo(() => deriveVisibleIds(memories, filterState), [memories, filterState]);

  // E4 proper: code-review-critic HIGH #1 — disambiguate "no filter" from
  // "filter matched zero". Passed to useCanvasEngine + Sidebar.
  const filterActive = useMemo(() => isFilterActive(filterState), [filterState]);

  // E4 marquee: store the BrainScene instance so LabelOverlay can subscribe
  // to per-frame onRender callbacks for projection.
  const [sceneInstance, setSceneInstance] = useState<BrainScene | null>(null);

  // E5 S2: L key toggles drawer. Skip when target is in a form input or
  // already inside the drawer (so arrow nav over rows isn't shadowed).
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.target instanceof HTMLElement && e.target.closest('[data-drawer="memory-list"]')) return;
      if (e.key === "l" || e.key === "L") {
        e.preventDefault();
        setDrawerOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setSize({ width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const onHover = useCallback((memory: Memory | null, x: number, y: number) => {
    if (selectedMemory) return;
    setHoveredMemory(memory ? { memory, x, y } : null);
  }, [selectedMemory]);

  const onClickMemory = useCallback((memory: Memory | null) => {
    setSelectedMemory(memory);
    setHoveredMemory(null);
  }, []);

  const { containerRef, handleMouseMove, handleClick, handleKeyDown } = useCanvasEngine({
    memories, embeddings, conflicts, width: size.width, height: size.height,
    onHover, onClick: onClickMemory,
    searchQuery: filterState.query,
    frozen: filterState.frozen,
    visibleIds,
    filterActive,
    onSceneReady: setSceneInstance,
  });

  // Uses the shared matchesQuery so this can't drift from deriveVisibleIds.
  const matchCount = filterState.query.trim().length > 0
    ? memories.filter((m) => matchesQuery(m, filterState.query)).length
    : null;

  const panelOpen = selectedMemory !== null;

  return (
    <div ref={wrapperRef} style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden" }} onKeyDown={handleKeyDown} tabIndex={0}>

      {/* E5 S3: skip-link is the FIRST focusable element so SR/keyboard
          users land on it on Tab. */}
      <SkipLink onActivate={() => setDrawerOpen(true)} />

      {/* P2 mockup chrome: framed map-area container. E5 S4: role="region"
          on the outer container, aria-hidden="true" on the INNER canvas
          wrapper. The SR escape hatch button is a SIBLING of the
          aria-hidden wrapper (plan-eng R2 MED fix: aria-hidden cascades,
          so the button could not live inside it). */}
      <div
        role="region"
        aria-label="Memory graph (visual representation)"
        style={{
          position: "absolute",
          top: 48 + 24,
          left: 24,
          right: 340 + 24,
          bottom: 36 + 24,
          border: "1px solid var(--border)",
          borderRadius: 2,
          background: "var(--map-bg)",
          overflow: "hidden",
          zIndex: 0,
        }}
      >
        <div aria-hidden="true" style={{ position: "absolute", inset: 0 }}>
          <div
            ref={containerRef}
            onMouseMove={handleMouseMove}
            onClick={handleClick}
            style={{ position: "absolute", inset: 0 }}
          />
        </div>

        {/* SR escape hatch — sibling of aria-hidden wrapper. SR users
            who Tab INTO this region get an actionable way out. */}
        <button
          type="button"
          className="sr-only"
          onClick={() => setDrawerOpen(true)}
        >
          For a tabular alternative, view the memory list ({memories.length} memories)
        </button>
      </div>

      <Header
        memoryCount={memories.length}
        matchCount={matchCount}
        stats={stats}
        filterState={filterState}
        frozenOrigin={frozenOrigin}
        setQuery={setQuery}
        setFrozen={setFrozen}
      />

      {/* P3 marquee feature: per-frame HTML node-label overlay. */}
      <LabelOverlay
        memories={memories}
        visibleIds={visibleIds}
        filterActive={filterActive}
        scene={sceneInstance}
      />

      <Sidebar
        memories={memories}
        stats={stats}
        visibleIds={visibleIds}
        filterActive={filterActive}
        selectedMemory={selectedMemory}
        filterState={filterState}
        setQuery={setQuery}
        setLayers={setLayers}
        setStrengthRange={setStrengthRange}
        setConfidences={setConfidences}
        setAgeMaxDays={setAgeMaxDays}
        resetFilters={resetFilters}
      />

      {matchCount === 0 && filterState.query.trim().length > 0 && (
        <div style={{
          position: "absolute", top: 56, right: 24, zIndex: 21,
          background: "var(--ink-faint)", padding: "4px 12px", borderRadius: 12,
          fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--dim)",
        }}>
          no matches
        </div>
      )}

      {hoveredMemory && !selectedMemory && (
        <MemoryTooltip memory={hoveredMemory.memory} x={hoveredMemory.x} y={hoveredMemory.y} />
      )}

      <DetailPanel memory={selectedMemory} onClose={() => setSelectedMemory(null)} open={panelOpen} />

      {/* E5 S1: drawer mirror. Always rendered (CSS transform-hide), so SR
          users always have access. */}
      <Drawer
        memories={memories}
        visibleIds={visibleIds}
        filterActive={filterActive}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onMemorySelect={(m) => {
          setSelectedMemory(m);
          setHoveredMemory(null);
        }}
        selectedMemoryId={selectedMemory?.id ?? null}
        resetFilters={resetFilters}
      />

      {/* P2 mockup chrome: bottom-bar with shortcuts + affordance key + drawer toggle. */}
      <BottomBar
        drawerOpen={drawerOpen}
        onToggleDrawer={() => setDrawerOpen((prev) => !prev)}
        visibleCount={filterActive ? visibleIds.size : memories.length}
      />
    </div>
  );
}
