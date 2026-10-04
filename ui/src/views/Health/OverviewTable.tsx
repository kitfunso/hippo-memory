import { useMemo, useState } from "react";
import type { ProjectSummary } from "../../types";
import { riskColor } from "./canvas/riskColor";
import { fmt, pct, projectLabel, rel } from "./format";
import { type VColumn, VTable } from "./VTable";

const COLUMNS: readonly VColumn[] = [
  { key: "name", label: "Project", width: "minmax(150px,1fr)" },
  { key: "live", label: "Memories", width: "100px", right: true },
  { key: "share", label: "At risk", width: "112px", right: true },
  { key: "openConflicts", label: "Conflicts", width: "92px", right: true },
  { key: "embedded", label: "Embedded", width: "96px", right: true },
  { key: "lastUsed", label: "Last used", width: "98px", right: true },
];

const NEVER = 1e9;

type SortKey = "name" | "live" | "share" | "openConflicts" | "embedded" | "lastUsed";

function isSortKey(key: string): key is SortKey {
  return COLUMNS.some((c) => c.key === key);
}

function numberValue(p: ProjectSummary, key: Exclude<SortKey, "name">): number {
  if (key === "embedded") return p.live ? p.embedded / p.live : 0;
  if (key === "lastUsed") return p.lastRetrievedDays ?? NEVER;
  return p[key];
}

function compare(a: ProjectSummary, b: ProjectSummary, key: SortKey): number {
  return key === "name" ? projectLabel(a).localeCompare(projectLabel(b)) : numberValue(a, key) - numberValue(b, key);
}

/** Projects that match the search (all when none), sorted; ties fall back to key order so rows never jump. */
export function sortProjects(
  projects: readonly ProjectSummary[],
  hits: ReadonlyMap<string, number> | null,
  key: SortKey,
  dir: "asc" | "desc",
): ProjectSummary[] {
  const sign = dir === "asc" ? 1 : -1;
  return projects
    .filter((p) => p.live > 0 && (!hits || (hits.get(p.key) ?? 0) > 0))
    .sort((a, b) => compare(a, b, key) * sign || a.key.localeCompare(b.key));
}

interface OverviewTableProps {
  projects: readonly ProjectSummary[];
  hits: ReadonlyMap<string, number> | null;
  query: string;
  onOpen: (key: string) => void;
}

/** Keyboard-reachable twin of the treemap: the same numbers, one row per project. */
export function OverviewTable({ projects, hits, query, onOpen }: OverviewTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("live");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const rows = useMemo(() => sortProjects(projects, hits, sortKey, dir), [projects, hits, sortKey, dir]);

  const onSort = (key: string) => {
    if (!isSortKey(key)) return;
    if (key === sortKey) setDir(dir === "asc" ? "desc" : "asc");
    else {
      setSortKey(key);
      setDir(key === "name" ? "asc" : "desc");
    }
  };

  return (
    <VTable
      id="ovt"
      label="Projects table"
      columns={COLUMNS}
      count={rows.length}
      rowHeight={44}
      sortKey={sortKey}
      sortDir={dir}
      onSort={onSort}
      resetKey={`${sortKey}:${dir}:${query}`}
      onActivate={(i) => onOpen(rows[i].key)}
      rowState={() => ({ selected: hits !== null })}
      empty={query ? `No projects match "${query}"` : "No projects"}
      renderRow={(i) => {
        const p = rows[i];
        const name = projectLabel(p);
        return (
          <>
            <div role="gridcell" className="c lnk" title={name}>
              {name}
            </div>
            <div role="gridcell" className="c r n">
              {fmt(p.live)}
            </div>
            <div role="gridcell" className="c r n">
              <span className="sw swatch" style={{ background: riskColor(p.share).css }} aria-hidden="true" />
              {pct(p.share)}
            </div>
            <div role="gridcell" className="c r n">
              {p.openConflicts > 0 ? (
                <>
                  <span className="sw hatch swatch-sm" aria-hidden="true" />
                  {p.openConflicts}
                </>
              ) : (
                <span className="muted">0</span>
              )}
            </div>
            <div role="gridcell" className="c r n">
              {pct(p.live ? p.embedded / p.live : 0, 0)}
            </div>
            <div role="gridcell" className="c r n">
              {p.lastRetrievedDays === null ? "never" : rel(p.lastRetrievedDays)}
            </div>
          </>
        );
      }}
    />
  );
}
