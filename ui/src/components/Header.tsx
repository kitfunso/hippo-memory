/**
 * E2 Header component. Consolidates the inline header markup that LivingMap
 * carried since v0.1: logo, subtitle, memory count, at-risk count, layer
 * legend, search input, freeze toggle.
 *
 * Per plan v2 E2 acceptance: search input is debounced 150ms before
 * forwarding to setQuery so scene.setHighlighted is called at most twice
 * for a 10-character query.
 */

import { useState, useEffect } from "react";
import type { Stats } from "../types.js";
import type { FilterState } from "../state/filterState.js";
import { LayerLegend } from "./LayerLegend.js";
import { useDebouncedValue } from "../hooks/useDebouncedValue.js";

interface HeaderProps {
  memoryCount: number;
  matchCount: number | null;
  stats: Stats | null;
  filterState: FilterState;
  setQuery: (query: string) => void;
  setFrozen: (frozen: boolean) => void;
}

export function Header({ memoryCount, matchCount, stats, filterState, setQuery, setFrozen }: HeaderProps) {
  // Local input state - debounced before propagating to FilterState. This
  // keeps typing snappy while delaying the scene re-highlight by 150ms.
  const [inputValue, setInputValue] = useState(filterState.query);
  const debounced = useDebouncedValue(inputValue, 150);
  const [focused, setFocused] = useState(false);

  // Forward debounced changes to parent. The parent's filterState.query
  // is what useCanvasEngine actually consumes.
  useEffect(() => {
    if (debounced !== filterState.query) setQuery(debounced);
  }, [debounced]); // eslint-disable-line react-hooks/exhaustive-deps

  // External clears (e.g. "esc to clear search") should reset the local input.
  useEffect(() => {
    if (filterState.query === "" && inputValue !== "") setInputValue("");
  }, [filterState.query]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{
      position: "absolute", top: 0, left: 0, right: 0, height: 48, zIndex: 20,
      background: "var(--glass-bg)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)",
      borderBottom: "1px solid var(--glass-border)",
      display: "flex", alignItems: "center", padding: "0 24px", gap: 20,
      pointerEvents: "auto",
    }}>
      <div style={{ flex: "0 0 auto", display: "flex", alignItems: "baseline", gap: 12 }}>
        <span style={{ color: "var(--text)", fontSize: 16, fontWeight: 700, fontFamily: "var(--font-serif)", letterSpacing: "0.3px" }}>
          hippo
        </span>
        <span style={{ color: "var(--accent)", fontSize: 11, fontFamily: "var(--font-serif)", fontStyle: "italic" }}>
          brain observatory
        </span>
        <span style={{ color: "var(--dim)", fontSize: 10, fontFamily: "var(--font-mono)" }}>
          {memoryCount} memories
        </span>
        {(stats?.at_risk ?? 0) > 0 && (
          <span style={{ color: "var(--yellow)", fontSize: 10, fontFamily: "var(--font-mono)" }}>
            {stats?.at_risk} fading
          </span>
        )}
      </div>

      <div style={{ flex: 1 }} />

      <LayerLegend />

      <div style={{ position: "relative", width: 200 }}>
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          aria-label="Search memories"
          placeholder="search…"
          style={{
            width: "100%",
            padding: "5px 10px",
            paddingRight: matchCount !== null ? 48 : 10,
            background: focused ? "var(--ink-faint)" : "var(--glass-bg)",
            border: focused ? "1px solid var(--accent-focus)" : "1px solid var(--glass-border)",
            borderRadius: 4,
            color: "var(--text)",
            fontSize: 12,
            fontFamily: "var(--font-serif)",
            outline: "none",
            boxSizing: "border-box" as const,
            transition: "border-color 200ms ease, background 200ms ease",
            letterSpacing: "0.2px",
          }}
        />
        {matchCount !== null && (
          <span style={{
            position: "absolute",
            right: 8,
            top: "50%",
            transform: "translateY(-50%)",
            color: "var(--text-faint)",
            fontSize: 9,
            fontFamily: "var(--font-mono)",
            pointerEvents: "none",
          }}>
            {matchCount}/{memoryCount}
          </span>
        )}
      </div>

      <button
        type="button"
        onClick={() => setFrozen(!filterState.frozen)}
        aria-pressed={filterState.frozen}
        aria-label={filterState.frozen ? "Resume animation" : "Freeze animation"}
        title={filterState.frozen ? "Click to resume animation (or press F)" : "Click to freeze animation (or press F)"}
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          letterSpacing: "0.8px",
          textTransform: "uppercase",
          background: filterState.frozen ? "rgba(196,92,60,0.10)" : "transparent",
          border: `1px solid ${filterState.frozen ? "var(--accent)" : "var(--glass-border)"}`,
          color: filterState.frozen ? "var(--accent)" : "var(--dim)",
          padding: "5px 12px",
          borderRadius: 4,
          cursor: "pointer",
          transition: "color 150ms ease, border-color 150ms ease, background 150ms ease",
        }}
      >
        {filterState.frozen ? "frozen" : "freeze"}
      </button>
    </div>
  );
}
