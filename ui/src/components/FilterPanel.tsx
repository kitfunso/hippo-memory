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
      {/* Panel title moved to Sidebar.tsx so the 'reset' button can live
          next to it. */}

      {/* Layer checkboxes (code-review-critic HIGH #2 fix: invert semantics
          so the displayed checkbox state matches the data state, and the
          first uncheck-from-all-shown takes user intent literally rather
          than producing the inverse). */}
      <div style={filterGroup}>
        <div style={filterLabel}>
          <span>Layer</span>
          <span style={filterValue}>
            {filterState.layers.size === 0 ? "all" : `${filterState.layers.size}/3`}
          </span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 14px" }}>
          {ALL_LAYERS.map(({ key, label }) => {
            // When set is empty (no filter), all show as visually checked.
            const checked = filterState.layers.size === 0 || filterState.layers.has(key);
            return (
              <label key={key} style={chkRow}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    // From the "all" state (size===0), first uncheck means
                    // "exclude this one, keep the other two". Seed with the
                    // other layers so the user's mental model matches.
                    if (filterState.layers.size === 0) {
                      const others = ALL_LAYERS.filter((l) => l.key !== key).map((l) => l.key);
                      setLayers(new Set(others));
                    } else {
                      const next = toggleSet(filterState.layers, key);
                      // If unchecking would leave 0 selected, reset to "all".
                      setLayers(next.size === 0 ? new Set() : next);
                    }
                  }}
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

      {/* Strength range (code-review-critic HIGH #3 fix: crossover SWAPS
          rather than collapsing to a point. Old behavior: dragging min past
          max would clamp to [max, max], hiding every memory except those
          with strength exactly equal to that value. New: dragging min past
          max swaps them so the range stays meaningful at all positions). */}
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
              const v = parseFloat(e.target.value);
              setStrengthRange(v > strMax ? [strMax, v] : [v, strMax]);
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
              const v = parseFloat(e.target.value);
              setStrengthRange(v < strMin ? [v, strMin] : [strMin, v]);
            }}
            style={rangeStyle}
          />
        </div>
      </div>

      {/* Confidence multi-select (same HIGH #2 fix as layer: first
          uncheck-from-all seeds the other three rather than inverting). */}
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
                  onChange={() => {
                    if (filterState.confidences.size === 0) {
                      const others = ALL_CONFIDENCES.filter((l) => l.key !== key).map((l) => l.key);
                      setConfidences(new Set(others));
                    } else {
                      const next = toggleSet(filterState.confidences, key);
                      setConfidences(next.size === 0 ? new Set() : next);
                    }
                  }}
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

// (panelTitle removed - Sidebar.tsx now owns the panel header.)

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
