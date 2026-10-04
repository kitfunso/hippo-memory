import type { MemoryRow } from "../../types";
import type { RowOverlay } from "./actionController";
import { fmt } from "./format";
import type { MemoryPages } from "./useMemoryPages";

/** The memory at a table index once its page has landed, else null (placeholder or failed page). */
export function readyRow(pages: MemoryPages, index: number): MemoryRow | null {
  const slot = pages.rowAt(index);
  return slot.state === "ready" ? slot.row : null;
}

/** Extra row class while an action is pending on the row. */
export const rowClass = (overlay: RowOverlay | undefined): string => (overlay?.forgetting ? "forgetting" : "");

/** Flag chips of a row; a pending action shows its result at once, before the server confirms. */
export function RowFlags({ row, overlay }: { row: MemoryRow; overlay: RowOverlay | undefined }) {
  const pinned = overlay?.pinned ?? row.pinned;
  return (
    <>
      {pinned && <span className="flag pin">pinned</span>}
      {row.inConflict && !overlay?.resolved && <span className="flag cf">conflict</span>}
      {(row.wrong || overlay?.wrong) && <span className="flag wr">wrong</span>}
      {overlay?.kept && <span className="flag ok">kept</span>}
      {overlay?.weakened && <span className="flag wk">weakened</span>}
      {overlay?.forgetting && <span className="flag wr">forgetting</span>}
    </>
  );
}

/** Strength as a small bar plus the number; at-risk rows use the risk colour. */
export function StrengthBar({ row }: { row: MemoryRow }) {
  return (
    <>
      <span className={row.band === "atRisk" ? "bar risk" : "bar"} aria-hidden="true">
        <i style={{ width: `${Math.round(row.strength * 100)}%` }} />
      </span>
      {row.strength.toFixed(2)}
    </>
  );
}

/** Age in whole days, as the Age column shows it. */
export const ageText = (row: MemoryRow): string => `${fmt(row.ageDays)}d`;
