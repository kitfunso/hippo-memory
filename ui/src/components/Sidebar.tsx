/**
 * E3 Sidebar. Right-side panel container holding StatsPanel + FilterPanel
 * + TagCloud. Width 340px per hybrid-v4 mockup. Slides up under the 48px
 * header and stops at the wrapper bottom.
 */

import type { Memory, Stats } from "../types.js";
import type { FilterState, Layer, Confidence } from "../state/filterState.js";
import { StatsPanel } from "./StatsPanel.js";
import { FilterPanel } from "./FilterPanel.js";
import { TagCloud } from "./TagCloud.js";

interface SidebarProps {
  memories: Memory[];
  stats: Stats | null;
  visibleIds: Set<string>;
  filterState: FilterState;
  setQuery: (query: string) => void;
  setLayers: (layers: Set<Layer>) => void;
  setStrengthRange: (range: [number, number]) => void;
  setConfidences: (confidences: Set<Confidence>) => void;
  setAgeMaxDays: (days: number | null) => void;
}

export function Sidebar({
  memories,
  stats,
  visibleIds,
  filterState,
  setQuery,
  setLayers,
  setStrengthRange,
  setConfidences,
  setAgeMaxDays,
}: SidebarProps) {
  const totalVisible = visibleIds.size > 0 ? visibleIds.size : memories.length;

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
      <FilterPanel
        filterState={filterState}
        setLayers={setLayers}
        setStrengthRange={setStrengthRange}
        setConfidences={setConfidences}
        setAgeMaxDays={setAgeMaxDays}
      />
      <TagCloud
        memories={memories}
        visibleIds={visibleIds}
        onTagClick={(tag) => setQuery(tag)}
      />
    </aside>
  );
}
