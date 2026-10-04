import type { CSSProperties, ReactNode, Ref } from "react";
import { useImperativeHandle } from "react";
import { useVTable } from "./useVTable";

/** One column: `width` is a CSS grid track (e.g. "100px" or "minmax(150px,1fr)"). */
export interface VColumn {
  key: string;
  label: string;
  width: string;
  right?: boolean;
  nosort?: boolean;
}

/** Imperative handle: move focus to the grid or set the active row. */
export interface VTableHandle {
  focus: () => void;
  setActive: (index: number, scroll: boolean) => void;
}

/** Per-row presentation state. */
export interface VRowState {
  /** The row is the open one: highlighted and exposed as `aria-selected`. */
  selected?: boolean;
  /** Highlight only (a search hit); the row is not a selection, so no `aria-selected`. */
  hit?: boolean;
  className?: string;
}

/** Props of the virtual grid. `count` is the true row total (aria-rowcount counts the header too). */
export interface VTableProps {
  id: string;
  label: string;
  columns: readonly VColumn[];
  count: number;
  rowHeight: number;
  /** Row contents: one `role="gridcell"` element per column. */
  renderRow: (index: number) => ReactNode;
  rowState?: (index: number) => VRowState;
  onActivate: (index: number) => void;
  onFocusRow?: (index: number) => void;
  onSort?: (key: string) => void;
  sortKey?: string;
  sortDir?: "asc" | "desc";
  onWindow?: (first: number, last: number) => void;
  resetKey?: unknown;
  /** Shown over the body when `count` is 0. */
  empty: ReactNode;
  ref?: Ref<VTableHandle>;
}

/** Virtual data grid: only the visible rows are in the DOM; the grid root holds focus (aria-activedescendant). */
export function VTable(props: VTableProps) {
  const { id, label, columns, count, rowHeight, renderRow, rowState, onSort, sortKey, sortDir, empty } = props;
  const t = useVTable({
    rowHeight,
    count,
    onActivate: props.onActivate,
    onFocusRow: props.onFocusRow,
    onWindow: props.onWindow,
    resetKey: props.resetKey,
  });
  useImperativeHandle(props.ref, () => ({ focus: () => t.rootRef.current?.focus(), setActive: t.setActive }), [t.setActive, t.rootRef]);

  const rows: ReactNode[] = [];
  for (let i = t.first; i < t.last; i++) {
    const state = rowState?.(i) ?? {};
    const cls = ["vt-tr", i === t.active ? "act" : "", state.selected || state.hit ? "sel" : "", state.className ?? ""].filter(Boolean).join(" ");
    rows.push(
      <div
        key={i}
        role="row"
        id={`${id}-r${i}`}
        aria-rowindex={i + 2}
        aria-selected={state.selected ? true : undefined}
        className={cls}
        style={{ top: i * rowHeight, height: rowHeight }}
        onClick={() => {
          t.setActive(i, false);
          props.onActivate(i);
        }}
      >
        {renderRow(i)}
      </div>,
    );
  }

  // SAFETY: React's CSSProperties has no custom-property keys; the browser accepts them.
  const style = { "--cols": columns.map((c) => c.width).join(" ") } as CSSProperties;
  return (
    <div
      ref={t.rootRef}
      className="vt"
      role="grid"
      aria-label={label}
      aria-rowcount={count + 1}
      aria-activedescendant={t.active >= 0 ? `${id}-r${t.active}` : undefined}
      tabIndex={0}
      style={style}
      onKeyDown={t.onRootKeyDown}
      onFocus={(e) => {
        if (e.target === e.currentTarget) t.onRootFocus();
      }}
    >
      <div className="vt-head" role="row" aria-rowindex={1}>
        {columns.map((c) => {
          const on = sortKey === c.key;
          return (
            <div
              key={c.key}
              className={c.right ? "vt-th r" : "vt-th"}
              role="columnheader"
              aria-sort={on ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
            >
              {c.nosort || !onSort ? (
                <span className="h">{c.label}</span>
              ) : (
                <button type="button" onClick={() => onSort(c.key)}>
                  {c.label}
                  <span className="ar" aria-hidden="true">
                    {on ? (sortDir === "asc" ? "▲" : "▼") : ""}
                  </span>
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div ref={t.bodyRef} className="vt-body" tabIndex={-1} onScroll={t.onScroll}>
        <div className="vt-sp" role="rowgroup" style={{ height: count * rowHeight }}>
          {rows}
        </div>
      </div>
      {count === 0 && <div className="vt-empty">{empty}</div>}
    </div>
  );
}
