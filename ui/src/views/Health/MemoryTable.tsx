import type { ReactNode, Ref } from "react";
import type { MemorySort, SortDir } from "../../api/client";
import { useIsPhone } from "../../hooks/useMediaQuery";
import { useActions } from "./actions";
import { LayerMark } from "./LayerMark";
import { MemoryCards } from "./MemoryCards";
import { rel } from "./format";
import { RowFlags, StrengthBar, ageText, readyRow, rowClass } from "./rowParts";
import { SORT_LABELS, SORT_KEYS, isSort } from "./tableSort";
import type { MemoryPages } from "./useMemoryPages";
import { type VColumn, type VTableHandle, VTable } from "./VTable";

const WIDTHS = {
  content: "minmax(240px,1fr)",
  layer: "108px",
  strength: "132px",
  retrievals: "72px",
  last: "100px",
  age: "84px",
  confidence: "108px",
  scope: "110px",
} satisfies Record<MemorySort, string>;
const RIGHT: readonly MemorySort[] = ["retrievals", "last", "age"];

const COLUMNS: readonly VColumn[] = SORT_KEYS.map((key) => ({ key, label: SORT_LABELS[key], width: WIDTHS[key], right: RIGHT.includes(key) }));

/** What the memory table needs from the project view; the grid and the phone card list take the same props. */
export interface TableProps {
  pages: MemoryPages;
  count: number;
  sortKey: MemorySort;
  sortDir: SortDir;
  onSort: (key: MemorySort) => void;
  /** Phone only: flips the direction without changing the key. */
  onToggleDir: () => void;
  /** Changing this scrolls to the top and clears the active row. */
  resetKey: string;
  /** The memory the drawer shows, or null. */
  activeId: string | null;
  /** Row click or Enter. */
  onOpen: (index: number, id: string) => void;
  /** The active row moved by keyboard; an open desktop drawer follows it. */
  onPreview: (index: number, id: string) => void;
  empty: ReactNode;
  ref?: Ref<VTableHandle>;
}

function MemoryGrid({ pages, count, sortKey, sortDir, onSort, resetKey, activeId, onOpen, onPreview, empty, ref }: TableProps) {
  const { overlay } = useActions();
  return (
    <VTable
      id="mt"
      label="Memories"
      columns={COLUMNS}
      count={count}
      rowHeight={44}
      sortKey={sortKey}
      sortDir={sortDir}
      onSort={(key) => isSort(key) && onSort(key)}
      resetKey={resetKey}
      onWindow={pages.want}
      onActivate={(i) => {
        const row = readyRow(pages, i);
        if (row) onOpen(i, row.id);
      }}
      onFocusRow={(i) => {
        const row = readyRow(pages, i);
        if (row) onPreview(i, row.id);
      }}
      rowState={(i) => {
        const row = readyRow(pages, i);
        return { selected: row !== null && row.id === activeId, className: rowClass(row ? overlay.get(row.id) : undefined) };
      }}
      empty={empty}
      ref={ref}
      renderRow={(i) => {
        const slot = pages.rowAt(i);
        if (slot.state === "error") {
          return (
            <div role="gridcell" className="c row-err">
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
          );
        }
        if (slot.state === "loading") {
          return COLUMNS.map((c, n) => (
            <div key={c.key} role="gridcell" className="c" aria-busy="true">
              {n === 0 && <span className="skel skel-cell" />}
            </div>
          ));
        }
        const { row } = slot;
        const flags = overlay.get(row.id);
        return (
          <>
            <div role="gridcell" className="c" title={row.content}>
              <RowFlags row={row} overlay={flags} />
              {row.content}
              {row.truncated && "…"}
            </div>
            <div role="gridcell" className="c">
              <LayerMark layer={row.layer} />
              {row.layer}
            </div>
            <div role="gridcell" className="c n">
              <StrengthBar row={row} />
            </div>
            <div role="gridcell" className="c r n">
              {row.retrievals}
            </div>
            <div role="gridcell" className="c r n">
              {rel(row.lastRetrievedDays)}
            </div>
            <div role="gridcell" className="c r n">
              {ageText(row)}
            </div>
            <div role="gridcell" className="c">
              {row.confidence}
            </div>
            <div role="gridcell" className="c muted">
              {row.scope ?? "none"}
            </div>
          </>
        );
      }}
    />
  );
}

/** The project's memories, 100-row server pages: a data grid on desktop, a card list at the phone width. */
export function MemoryTable(props: TableProps) {
  return useIsPhone() ? <MemoryCards {...props} /> : <MemoryGrid {...props} />;
}
