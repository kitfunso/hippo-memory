/**
 * E3 Sidebar. Right-side panel container holding StatsPanel + FilterPanel
 * + TagCloud. Width 340px per hybrid-v4 mockup. Slides up under the 48px
 * header and stops at the wrapper bottom.
 */

import type { Memory, Stats } from "../types.js";
import { INITIAL_FILTER_STATE, type FilterState, type Layer, type Confidence } from "../state/filterState.js";
import { StatsPanel } from "./StatsPanel.js";
import { FilterPanel } from "./FilterPanel.js";
import { TagCloud } from "./TagCloud.js";

interface SidebarProps {
  memories: Memory[];
  stats: Stats | null;
  visibleIds: Set<string>;
  filterActive: boolean;
  selectedMemory: Memory | null;
  filterState: FilterState;
  setQuery: (query: string) => void;
  setLayers: (layers: Set<Layer>) => void;
  setStrengthRange: (range: [number, number]) => void;
  setConfidences: (confidences: Set<Confidence>) => void;
  setAgeMaxDays: (days: number | null) => void;
  /** P4: reset all filters back to INITIAL_FILTER_STATE (keeping frozen flag). */
  resetFilters: () => void;
}

export function Sidebar({
  memories,
  stats,
  visibleIds,
  filterActive,
  selectedMemory,
  filterState,
  setQuery,
  setLayers,
  setStrengthRange,
  setConfidences,
  setAgeMaxDays,
  resetFilters,
}: SidebarProps) {
  // Code-review-critic HIGH #1 fix: when filter is active and matches zero,
  // totalVisible should be 0, not memories.length.
  const totalVisible = filterActive ? visibleIds.size : memories.length;

  return (
    <aside
      aria-label="Filters and stats"
      style={{
        position: "absolute",
        top: 48,
        right: 0,
        width: 340,
        height: "calc(100% - 48px)",
        background: "var(--glass-bg)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderLeft: "1px solid var(--glass-border)",
        padding: "20px",
        overflowY: "auto",
        zIndex: 10,
        boxSizing: "border-box",
      }}
    >
      <StatsPanel stats={stats} totalVisible={totalVisible} />

      {/* P2 mockup chrome: selected-memory hint when nothing selected, so
          the sidebar doesn't dead-end visually. Per plan-design-critic HIGH. */}
      <div style={{ marginBottom: 20 }}>
        <h3 style={panelTitle}>Selected memory</h3>
        {selectedMemory ? (
          <div style={{ fontSize: 11, color: "var(--text)", fontFamily: "var(--font-serif)" }}>
            <div style={{ marginBottom: 4, color: "var(--dim)", fontFamily: "var(--font-mono)", fontSize: 9 }}>
              {selectedMemory.id}
            </div>
            <div style={{ lineHeight: 1.5 }}>
              {selectedMemory.content.length > 140
                ? selectedMemory.content.slice(0, 137) + "…"
                : selectedMemory.content}
            </div>
            <div style={{ marginTop: 6, color: "var(--dim)", fontFamily: "var(--font-mono)", fontSize: 9 }}>
              click again or press <em>esc</em> to deselect
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 11, color: "var(--text-faint)", fontStyle: "italic", fontFamily: "var(--font-serif)" }}>
            click a memory to see details
          </div>
        )}
      </div>

      {/* P4 reset button row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, paddingBottom: 6, borderBottom: "1px solid var(--glass-border)" }}>
        <h3 style={{ ...panelTitle, margin: 0, padding: 0, border: 0 }}>Filters</h3>
        {filterActive && (
          <button
            type="button"
            onClick={resetFilters}
            aria-label="Reset all filters"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--accent)",
              cursor: "pointer",
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              textTransform: "uppercase",
              letterSpacing: "0.8px",
              padding: "2px 4px",
            }}
          >
            reset
          </button>
        )}
      </div>

      <FilterPanel
        filterState={filterState}
        setLayers={setLayers}
        setStrengthRange={setStrengthRange}
        setConfidences={setConfidences}
        setAgeMaxDays={setAgeMaxDays}
      />

      {/* Empty filter-match state */}
      {filterActive && visibleIds.size === 0 && (
        <div style={{
          fontSize: 11,
          color: "var(--accent)",
          fontStyle: "italic",
          fontFamily: "var(--font-serif)",
          padding: "8px 10px",
          background: "var(--ink-faint)",
          borderRadius: 3,
          marginBottom: 16,
        }}>
          no memories match these filters
        </div>
      )}

      <TagCloud
        memories={memories}
        visibleIds={filterActive ? visibleIds : new Set()}
        onTagClick={(tag) => setQuery(tag)}
      />
    </aside>
  );
}

const panelTitle = {
  fontSize: 11,
  fontVariant: "small-caps" as const,
  letterSpacing: "1px",
  fontWeight: 400,
  color: "var(--dim)",
  marginBottom: 10,
  paddingBottom: 6,
  borderBottom: "1px solid var(--glass-border)",
};
