import { type ReactNode, useEffect, useImperativeHandle, useState } from "react";
import { useActions } from "./actions";
import { LayerMark } from "./LayerMark";
import type { TableProps } from "./MemoryTable";
import { RowFlags, ageText, readyRow, rowClass } from "./rowParts";
import { SORT_KEYS, SORT_LABELS, isSort } from "./tableSort";
import { useVTable } from "./useVTable";

const CARD_REM = 4.75;
const FALLBACK_PX = 16;

/** Card height in px: 4.75 rem against the root font size the user has set. */
function cardHeight(): number {
  const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Math.round(CARD_REM * (root > 0 ? root : FALLBACK_PX));
}

/** The card height, recomputed on resize because browser text zoom fires it. */
function useCardHeight(): number {
  const [height, setHeight] = useState(cardHeight);
  useEffect(() => {
    const onResize = () => setHeight(cardHeight());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return height;
}

/** Phone memory list: one tall card per memory, a "Sort by" select and a direction toggle in place of column headers. */
export function MemoryCards({ pages, count, sortKey, sortDir, onSort, onToggleDir, resetKey, activeId, onOpen, onPreview, empty, ref }: TableProps) {
  const { overlay } = useActions();
  const height = useCardHeight();
  const t = useVTable({
    rowHeight: height,
    count,
    resetKey,
    onWindow: pages.want,
    onActivate: (i) => {
      const row = readyRow(pages, i);
      if (row) onOpen(i, row.id);
    },
    onFocusRow: (i) => {
      const row = readyRow(pages, i);
      if (row) onPreview(i, row.id);
    },
  });
  useImperativeHandle(ref, () => ({ focus: () => t.rootRef.current?.focus(), setActive: t.setActive }), [t.rootRef, t.setActive]);

  const rows: ReactNode[] = [];
  for (let i = t.first; i < t.last; i++) {
    const slot = pages.rowAt(i);
    const row = slot.state === "ready" ? slot.row : null;
    const flags = row ? overlay.get(row.id) : undefined;
    const cls = ["mc-row", i === t.active ? "act" : "", row !== null && row.id === activeId ? "sel" : "", rowClass(flags)].filter(Boolean).join(" ");
    rows.push(
      <div
        key={i}
        id={`mc-r${i}`}
        role="option"
        aria-selected={row !== null && row.id === activeId}
        aria-posinset={i + 1}
        aria-setsize={count}
        className={cls}
        style={{ top: i * height, height }}
        onClick={() => {
          t.setActive(i, false);
          if (row) onOpen(i, row.id);
        }}
      >
        {slot.state === "error" && (
          <div className="row-err">
            <span>{slot.message}</span>
            <button
              type="button"
              className="btn quiet"
              onClick={(e) => {
                e.stopPropagation();
                pages.retry(i);
              }}
            >
              Retry
            </button>
          </div>
        )}
        {slot.state === "loading" && <span className="skel skel-cell" aria-busy="true" />}
        {row && (
          <>
            <div className="mc-text">{row.content}</div>
            <div className="mc-meta">
              <LayerMark layer={row.layer} />
              <span>{row.layer}</span>
              <span className="n">{row.strength.toFixed(2)}</span>
              <span className="n">{ageText(row)}</span>
              <RowFlags row={row} overlay={flags} />
            </div>
          </>
        )}
      </div>,
    );
  }

  return (
    <div className="mc">
      <div className="mc-bar">
        <label htmlFor="mc-sort">Sort by</label>
        <select
          id="mc-sort"
          className="ctl"
          value={sortKey}
          onChange={(e) => {
            const key = e.target.value;
            if (isSort(key)) onSort(key);
          }}
        >
          {SORT_KEYS.map((key) => (
            <option key={key} value={key}>
              {SORT_LABELS[key]}
            </option>
          ))}
        </select>
        <button type="button" className="tog" aria-label={`Sort direction: ${sortDir === "asc" ? "ascending" : "descending"}`} onClick={onToggleDir}>
          {sortDir === "asc" ? "▲" : "▼"}
        </button>
      </div>
      <div
        ref={t.rootRef}
        className="vt"
        role="listbox"
        aria-label="Memories"
        aria-activedescendant={t.active >= 0 ? `mc-r${t.active}` : undefined}
        tabIndex={0}
        onKeyDown={t.onRootKeyDown}
        onFocus={(e) => {
          if (e.target === e.currentTarget) t.onRootFocus();
        }}
      >
        <div ref={t.bodyRef} className="vt-body" tabIndex={-1} onScroll={t.onScroll}>
          <div className="vt-sp" style={{ height: count * height }}>
            {rows}
          </div>
        </div>
        {count === 0 && <div className="vt-empty mc-empty">{empty}</div>}
      </div>
    </div>
  );
}
