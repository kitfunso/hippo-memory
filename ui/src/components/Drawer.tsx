/**
 * E5 S1 — Drawer. Slide-up table mirror of the memory list, always
 * rendered to DOM so SR users have access even when sighted users have
 * the drawer hidden. 280px height. Keyboard nav: arrows move row focus,
 * Enter selects, Esc closes.
 *
 * Filter-aware: rows = filterActive ? memories.filter(m => visibleIds.has(m.id)) : memories.
 */

import { useEffect, useMemo, useRef } from "react";
import type { Memory } from "../types.js";
import { LAYER_COLORS } from "../engine/types.js";

interface DrawerProps {
  memories: Memory[];
  visibleIds: Set<string>;
  filterActive: boolean;
  open: boolean;
  onClose: () => void;
  onMemorySelect: (m: Memory) => void;
  selectedMemoryId: string | null;
  resetFilters: () => void;
}

const DRAWER_HEIGHT = 280;

function truncate(s: string, n: number): string {
  const flat = s.split(/\n/)[0]?.trim() ?? "";
  if (flat.length <= n) return flat;
  return flat.slice(0, n - 1).trimEnd() + "…";
}

export function Drawer({
  memories,
  visibleIds,
  filterActive,
  open,
  onClose,
  onMemorySelect,
  selectedMemoryId,
  resetFilters,
}: DrawerProps) {
  const rows = useMemo(() => {
    return filterActive ? memories.filter((m) => visibleIds.has(m.id)) : memories;
  }, [memories, visibleIds, filterActive]);

  const tbodyRef = useRef<HTMLTableSectionElement>(null);

  // Focus the selected row when the drawer opens (so SR users hear context).
  useEffect(() => {
    if (!open) return;
    const tbody = tbodyRef.current;
    if (!tbody) return;
    const targetRow = selectedMemoryId
      ? tbody.querySelector<HTMLTableRowElement>(`tr[data-memory-id="${selectedMemoryId}"]`)
      : tbody.querySelector<HTMLTableRowElement>("tr[data-memory-id]");
    targetRow?.focus();
  }, [open, selectedMemoryId]);

  // Arrow key navigation between rows.
  function handleTableKeyDown(e: React.KeyboardEvent<HTMLTableElement>) {
    const tbody = tbodyRef.current;
    if (!tbody) return;
    const focusable = Array.from(tbody.querySelectorAll<HTMLTableRowElement>("tr[data-memory-id]"));
    const currentIdx = focusable.findIndex((row) => row === document.activeElement);
    if (e.key === "ArrowDown" && currentIdx < focusable.length - 1) {
      e.preventDefault();
      focusable[currentIdx + 1]?.focus();
    } else if (e.key === "ArrowUp" && currentIdx > 0) {
      e.preventDefault();
      focusable[currentIdx - 1]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if ((e.key === "Enter" || e.key === " ") && currentIdx >= 0) {
      e.preventDefault();
      const row = focusable[currentIdx];
      const id = row?.dataset.memoryId;
      const memory = id ? memories.find((m) => m.id === id) : undefined;
      if (memory) onMemorySelect(memory);
    }
  }

  return (
    <div
      id="memory-drawer"
      role="region"
      aria-label={`Memory list view, ${rows.length} ${rows.length === 1 ? "memory" : "memories"}${filterActive ? " (filtered)" : ""}`}
      // data-attribute lets the global F-key handler skip when target is inside.
      data-drawer="memory-list"
      style={{
        position: "absolute",
        bottom: 36, // sits on top of the BottomBar
        left: 0,
        right: 0,
        height: DRAWER_HEIGHT,
        background: "var(--glass-bg-strong)",
        backdropFilter: "blur(24px)",
        WebkitBackdropFilter: "blur(24px)",
        borderTop: "1px solid var(--glass-border)",
        boxShadow: "0 -4px 24px var(--ink-shadow)",
        transform: open ? "translateY(0)" : `translateY(${DRAWER_HEIGHT}px)`,
        transition: "transform 250ms cubic-bezier(0.16, 1, 0.3, 1)",
        overflow: "hidden",
        zIndex: 22,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 20px",
        borderBottom: "1px solid var(--glass-border)",
      }}>
        <h2 style={{
          margin: 0,
          fontSize: 11,
          fontVariant: "small-caps",
          letterSpacing: "1px",
          color: "var(--dim)",
          fontWeight: 400,
        }}>
          Memory list
          <span style={{
            marginLeft: 8,
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "var(--text-faint)",
            letterSpacing: 0,
            fontVariant: "normal",
          }}>
            {rows.length}{filterActive ? " of " + memories.length + " (filtered)" : ""}
          </span>
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close memory list"
          style={{
            background: "var(--ink-faint)",
            border: "none",
            borderRadius: 3,
            color: "var(--dim)",
            cursor: "pointer",
            padding: "4px 10px",
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
            letterSpacing: "0.6px",
          }}
        >
          close (esc)
        </button>
      </div>

      {rows.length === 0 ? (
        <div style={{
          padding: "32px 20px",
          textAlign: "center",
          color: "var(--text-faint)",
          fontFamily: "var(--font-serif)",
          fontStyle: "italic",
          fontSize: 13,
        }}>
          no memories match these filters
          <div style={{ marginTop: 12 }}>
            <button
              type="button"
              onClick={resetFilters}
              style={{
                background: "transparent",
                border: "1px solid var(--accent)",
                color: "var(--accent)",
                padding: "4px 12px",
                borderRadius: 3,
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: "0.6px",
                cursor: "pointer",
                fontStyle: "normal",
              }}
            >
              reset filters
            </button>
          </div>
        </div>
      ) : (
        <div style={{ overflow: "auto", flex: 1 }}>
          <table
            onKeyDown={handleTableKeyDown}
            style={{
              width: "100%",
              borderCollapse: "collapse",
              tableLayout: "fixed",
            }}
          >
            <thead>
              <tr>
                <th style={thStyle} scope="col">id</th>
                <th style={thStyle} scope="col">content</th>
                <th style={{ ...thStyle, width: 60 }} scope="col">layer</th>
                <th style={{ ...thStyle, width: 70 }} scope="col">strength</th>
                <th style={{ ...thStyle, width: 60 }} scope="col">age</th>
              </tr>
            </thead>
            <tbody ref={tbodyRef}>
              {rows.map((m) => {
                const selected = m.id === selectedMemoryId;
                return (
                  <tr
                    key={m.id}
                    data-memory-id={m.id}
                    tabIndex={0}
                    role="row"
                    aria-selected={selected}
                    onClick={() => onMemorySelect(m)}
                    onFocus={(e) => {
                      // Ensure focused row is visible.
                      e.currentTarget.scrollIntoView({ block: "nearest" });
                    }}
                    style={{
                      cursor: "pointer",
                      borderLeft: selected ? "2px solid var(--accent)" : "2px solid transparent",
                      background: selected ? "rgba(196, 92, 60, 0.06)" : "transparent",
                      outline: "none",
                    }}
                    onMouseEnter={(e) => {
                      if (!selected) e.currentTarget.style.background = "rgba(196, 185, 168, 0.12)";
                    }}
                    onMouseLeave={(e) => {
                      if (!selected) e.currentTarget.style.background = "transparent";
                    }}
                  >
                    <td style={{ ...tdStyle, fontFamily: "var(--font-mono)", color: "var(--dim)", fontSize: 10 }}>
                      {m.id.slice(0, 10)}
                    </td>
                    <td style={{ ...tdStyle, color: "var(--text)", fontSize: 12, fontFamily: "var(--font-serif)" }}>
                      {truncate(m.content, 55)}
                    </td>
                    <td style={{ ...tdStyle, textAlign: "center" }}>
                      <span
                        title={m.layer}
                        style={{
                          display: "inline-block",
                          width: 7,
                          height: 7,
                          borderRadius: "50%",
                          background: LAYER_COLORS[m.layer],
                        }}
                      />
                    </td>
                    <td style={{ ...tdStyle, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text)" }}>
                      {m.strength.toFixed(2)}
                    </td>
                    <td style={{ ...tdStyle, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--dim)" }}>
                      {m.age_days}d
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "7px 20px",
  fontFamily: "var(--font-serif)",
  fontSize: 10,
  fontVariant: "small-caps",
  letterSpacing: "0.6px",
  color: "var(--dim)",
  fontWeight: 400,
  background: "var(--map-bg)",
  position: "sticky",
  top: 0,
};

const tdStyle: React.CSSProperties = {
  padding: "7px 20px",
  height: 28,
  verticalAlign: "middle",
  borderBottom: "1px solid var(--glass-border)",
};
