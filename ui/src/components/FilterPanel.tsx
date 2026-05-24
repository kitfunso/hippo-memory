/**
 * E3 FilterPanel. Layer checkboxes + strength range + confidence multi-select
 * + age slider. Filter state lives in App.tsx; this component renders + edits
 * it. Empty Set means "no filter active" (show all) per FilterState semantics.
 */

import type { FilterState, Layer, Confidence } from "../state/filterState.js";
import { LAYER_COLORS } from "../engine/types.js";

interface FilterPanelProps {
  filterState: FilterState;
  setLayers: (layers: Set<Layer>) => void;
  setStrengthRange: (range: [number, number]) => void;
  setConfidences: (confidences: Set<Confidence>) => void;
  setAgeMaxDays: (days: number | null) => void;
}

const ALL_LAYERS: Array<{ key: Layer; label: string }> = [
  { key: "buffer", label: "buffer" },
  { key: "episodic", label: "episodic" },
  { key: "semantic", label: "semantic" },
];

const ALL_CONFIDENCES: Array<{ key: Confidence; label: string }> = [
  { key: "verified", label: "verified" },
  { key: "observed", label: "observed" },
  { key: "inferred", label: "inferred" },
  { key: "stale", label: "stale" },
];

function toggleSet<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function FilterPanel({ filterState, setLayers, setStrengthRange, setConfidences, setAgeMaxDays }: FilterPanelProps) {
  const [strMin, strMax] = filterState.strengthRange;

  return (
    <div style={{ marginBottom: 20 }}>
      <h3 style={panelTitle}>Filters</h3>

      {/* Layer checkboxes */}
      <div style={filterGroup}>
        <div style={filterLabel}>
          <span>Layer</span>
          <span style={filterValue}>
            {filterState.layers.size === 0 ? "all" : `${filterState.layers.size}/3`}
          </span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 14px" }}>
          {ALL_LAYERS.map(({ key, label }) => {
            const checked = filterState.layers.size === 0 || filterState.layers.has(key);
            return (
              <label key={key} style={chkRow}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => setLayers(toggleSet(filterState.layers, key))}
                  aria-label={`Filter ${label}`}
                  style={{ accentColor: "var(--accent)", cursor: "pointer" }}
                />
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: LAYER_COLORS[key], display: "inline-block" }} />
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{label}</span>
              </label>
            );
          })}
        </div>
      </div>

      {/* Strength range */}
      <div style={filterGroup}>
        <div style={filterLabel}>
          <span>Strength</span>
          <span style={filterValue}>
            {strMin.toFixed(2)} – {strMax.toFixed(2)}
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={strMin}
            aria-label="Strength minimum"
            onChange={(e) => {
              const next = Math.min(parseFloat(e.target.value), strMax);
              setStrengthRange([next, strMax]);
            }}
            style={rangeStyle}
          />
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={strMax}
            aria-label="Strength maximum"
            onChange={(e) => {
              const next = Math.max(parseFloat(e.target.value), strMin);
              setStrengthRange([strMin, next]);
            }}
            style={rangeStyle}
          />
        </div>
      </div>

      {/* Confidence multi-select */}
      <div style={filterGroup}>
        <div style={filterLabel}>
          <span>Confidence</span>
          <span style={filterValue}>
            {filterState.confidences.size === 0 ? "all" : `${filterState.confidences.size}/4`}
          </span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 14px" }}>
          {ALL_CONFIDENCES.map(({ key, label }) => {
            const checked = filterState.confidences.size === 0 || filterState.confidences.has(key);
            return (
              <label key={key} style={chkRow}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => setConfidences(toggleSet(filterState.confidences, key))}
                  aria-label={`Filter ${label}`}
                  style={{ accentColor: "var(--accent)", cursor: "pointer" }}
                />
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{label}</span>
              </label>
            );
          })}
        </div>
      </div>

      {/* Age max */}
      <div style={filterGroup}>
        <div style={filterLabel}>
          <span>Max age</span>
          <span style={filterValue}>
            {filterState.ageMaxDays === null ? "any" : `≤ ${filterState.ageMaxDays}d`}
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={365}
          step={1}
          value={filterState.ageMaxDays ?? 365}
          aria-label="Max age in days"
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            setAgeMaxDays(v >= 365 ? null : v);
          }}
          style={rangeStyle}
        />
      </div>
    </div>
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

const filterGroup = {
  marginBottom: 14,
};

const filterLabel = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  fontSize: 11,
  fontVariant: "small-caps" as const,
  letterSpacing: "0.5px",
  color: "var(--dim)",
  marginBottom: 5,
};

const filterValue = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--text)",
  letterSpacing: 0,
};

const chkRow = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  fontSize: 12,
  cursor: "pointer",
  userSelect: "none" as const,
};

const rangeStyle = {
  width: "100%",
  accentColor: "var(--accent)",
};
