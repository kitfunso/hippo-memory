/**
 * v0.27 — ViewPanel. A new sibling section in Sidebar above "Filters".
 * Hosts the "Color by" segmented radio (layer | tag | path).
 *
 * Architectural note: colorMode is VIEW state, not filter state. It is
 * not in isFilterActive (toggling does not show filter-active UI), and
 * resetFilters preserves it (see App.tsx resetFilters). The user picked
 * a view; clearing filters should not undo their visual choice.
 *
 * Styles defined locally rather than imported from FilterPanel/Sidebar
 * (whose styles are not exported); keeps ViewPanel self-contained.
 */

import type { FilterState, ColorMode } from "../state/filterState.js";

interface ViewPanelProps {
  filterState: FilterState;
  setColorMode: (mode: ColorMode) => void;
}

const COLOR_MODES: Array<{ key: ColorMode; label: string; aria: string }> = [
  { key: "layer", label: "layer", aria: "Color nodes by memory layer (buffer, episodic, semantic)" },
  { key: "tag",   label: "tag",   aria: "Color nodes by their top topic tag" },
  { key: "path",  label: "path",  aria: "Color nodes by project path" },
];

export function ViewPanel({ filterState, setColorMode }: ViewPanelProps) {
  return (
    <div role="group" aria-label="View settings" style={{ marginBottom: 20 }}>
      <h3 style={panelTitle}>View</h3>
      <div style={filterLabel}>
        <span>Color by</span>
        <span style={filterValue}>{filterState.colorMode}</span>
      </div>
      <div role="radiogroup" aria-label="Color mode" style={segmentedGroup}>
        {COLOR_MODES.map(({ key, label, aria }) => {
          const checked = filterState.colorMode === key;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={aria}
              onClick={() => setColorMode(key)}
              style={{
                ...segmentBtn,
                background: checked ? "rgba(196, 92, 60, 0.10)" : "transparent",
                color: checked ? "var(--accent)" : "var(--dim)",
                borderColor: checked ? "var(--accent)" : "var(--glass-border)",
                fontWeight: checked ? 500 : 400,
              }}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Styles — defined locally to keep ViewPanel self-contained.
const panelTitle: React.CSSProperties = {
  fontSize: 11,
  fontVariant: "small-caps",
  letterSpacing: "1px",
  fontWeight: 400,
  color: "var(--dim)",
  marginBottom: 10,
  paddingBottom: 6,
  borderBottom: "1px solid var(--glass-border)",
};

const filterLabel: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  fontSize: 11,
  fontVariant: "small-caps",
  letterSpacing: "0.5px",
  color: "var(--dim)",
  marginBottom: 5,
};

const filterValue: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--text)",
  letterSpacing: "0.5px",
};

const segmentedGroup: React.CSSProperties = {
  display: "flex",
  gap: 4,
};

const segmentBtn: React.CSSProperties = {
  flex: 1,
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  padding: "5px 8px",
  borderRadius: 3,
  cursor: "pointer",
  transition: "color 150ms ease, border-color 150ms ease, background 150ms ease",
  border: "1px solid",
};
