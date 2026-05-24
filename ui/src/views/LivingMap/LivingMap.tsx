import { useState, useEffect, useRef, useCallback } from "react";
import type { Memory, Conflict, Stats, EmbeddingIndex } from "../../types.js";
import { useCanvasEngine } from "./useCanvasEngine.js";
import { MemoryTooltip } from "../../components/MemoryTooltip.js";
import { Header } from "../../components/Header.js";
import { LAYER_COLORS } from "../../engine/types.js";
import type { FilterState } from "../../state/filterState.js";

interface LivingMapProps {
  memories: Memory[];
  embeddings: EmbeddingIndex;
  stats: Stats | null;
  conflicts: Conflict[];
  filterState: FilterState;
  setQuery: (query: string) => void;
  setFrozen: (frozen: boolean) => void;
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

export function LivingMap({ memories, embeddings, stats, conflicts, filterState, setQuery, setFrozen }: LivingMapProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hoveredMemory, setHoveredMemory] = useState<{ memory: Memory; x: number; y: number } | null>(null);
  const [selectedMemory, setSelectedMemory] = useState<Memory | null>(null);
  const [showHint, setShowHint] = useState(true);

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

  useEffect(() => {
    if (memories.length === 0) return;
    const timer = setTimeout(() => setShowHint(false), 4000);
    return () => clearTimeout(timer);
  }, [memories.length]);

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
  });

  const matchCount = filterState.query.trim().length > 0
    ? memories.filter((m) => {
        const q = filterState.query.toLowerCase();
        return m.content.toLowerCase().includes(q) || m.tags.some((t) => t.toLowerCase().includes(q));
      }).length
    : null;

  const panelOpen = selectedMemory !== null;

  return (
    <div ref={wrapperRef} style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden" }} onKeyDown={handleKeyDown} tabIndex={0}>

      <div ref={containerRef} onMouseMove={handleMouseMove} onClick={handleClick}
        style={{ position: "absolute", inset: 0, zIndex: 0 }} />

      <Header
        memoryCount={memories.length}
        matchCount={matchCount}
        stats={stats}
        filterState={filterState}
        setQuery={setQuery}
        setFrozen={setFrozen}
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

      {showHint && memories.length > 0 && (
        <div style={{
          position: "absolute", bottom: 32, left: "50%", transform: "translateX(-50%)",
          fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-faint)",
          opacity: showHint ? 1 : 0, transition: "opacity 1s ease-out",
          pointerEvents: "none", zIndex: 5, letterSpacing: "3px",
        }}>
          orbit &middot; zoom &middot; click &middot; f to freeze
        </div>
      )}

      {hoveredMemory && !selectedMemory && (
        <MemoryTooltip memory={hoveredMemory.memory} x={hoveredMemory.x} y={hoveredMemory.y} />
      )}

      <DetailPanel memory={selectedMemory} onClose={() => setSelectedMemory(null)} open={panelOpen} />
    </div>
  );
}
