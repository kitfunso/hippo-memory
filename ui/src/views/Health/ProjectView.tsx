import { useCallback, useEffect, useRef, useState } from "react";
import { ALL_LAYERS, type Chip, type MemorySort, type SortDir, errorMessage, memoryPageQueryString } from "../../api/client";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { useIsPhone } from "../../hooks/useMediaQuery";
import { navigate, parseHash } from "../../router";
import type { Brush } from "./canvas/scatter";
import { DecayCard } from "./DecayCard";
import { fmt, keyLabel, plural, projectLabel, rel } from "./format";
import { useHealth } from "./HealthContext";
import { MemoryDrawer } from "./MemoryDrawer";
import { MemoryTable } from "./MemoryTable";
import { PhoneTop } from "./PhoneTop";
import { ScatterCard } from "./ScatterCard";
import { defaultDir } from "./tableSort";
import { type PageFilters, useMemoryPages } from "./useMemoryPages";
import { useProjectDetail } from "./useProjectDetail";
import type { VTableHandle } from "./VTable";

const BRUSH_MS = 250;
const CHIPS: readonly { chip: Chip; label: string }[] = [
  { chip: "all", label: "All" },
  { chip: "risk", label: "At risk" },
  { chip: "pinned", label: "Pinned" },
  { chip: "conflict", label: "In conflict" },
];

function brushQuery(b: Brush | null): Pick<PageFilters, "amin" | "amax" | "smin" | "smax"> {
  if (!b) return {};
  return { amin: Math.floor(b.a0), amax: Math.ceil(b.a1), smin: Math.floor(b.s0 * 100) / 100, smax: Math.ceil(b.s1 * 100) / 100 };
}

/** Reads the hash, not props: a handler that runs right after `navigate` must see the new route. */
function drawerIsOpen(): boolean {
  const route = parseHash(window.location.hash);
  return route.view === "health" && route.memoryId !== null;
}

/** One project: header, age and strength scatter, decay outlook, the paged memory table and the memory drawer. */
export function ProjectView({ projectKey, memoryId }: { projectKey: string; memoryId: string | null }) {
  const { search, clock, intent } = useHealth();
  const detail = useProjectDetail(projectKey);
  const phone = useIsPhone();
  const table = useRef<VTableHandle>(null);
  const opener = useRef<{ index: number; id: string } | null>(null);
  const [firstChip] = useState<Chip>(() => (intent.current?.key === projectKey ? intent.current.chip : "all"));
  const [chip, setChip] = useState<Chip>(firstChip);
  const [layerOn, setLayerOn] = useState<readonly boolean[]>(() => ALL_LAYERS.map(() => true));
  const [brush, setBrush] = useState<Brush | null>(null);
  const [brushRev, setBrushRev] = useState(0);
  const [sort, setSort] = useState<{ key: MemorySort; dir: SortDir }>({ key: "strength", dir: "asc" });
  const q = search.query;

  useEffect(() => {
    intent.current = null;
  }, [intent]);

  const settledBrush = useDebouncedValue(brush, BRUSH_MS);
  const filters: PageFilters = {
    sort: sort.key,
    dir: sort.dir,
    chip,
    layers: ALL_LAYERS.filter((_, i) => layerOn[i]),
    ...brushQuery(settledBrush),
    q: q === "" ? undefined : q,
  };
  const pages = useMemoryPages(projectKey, filters, clock);

  // Rows the brush selects, before the chip; the last value stays while a new query loads.
  const [selected, setSelected] = useState(0);
  const allCount = pages.counts?.all;
  if (allCount !== undefined && allCount !== selected) setSelected(allCount);

  const summary = detail.data?.summary;
  const name = summary ? projectLabel(summary) : keyLabel(projectKey);
  const hasFilters = chip !== "all" || !layerOn.every(Boolean) || brush !== null || q !== "";

  const setLayer = (i: number) => {
    const next = layerOn.map((on, k) => (k === i ? !on : on));
    if (next.some(Boolean)) setLayerOn(next);
  };
  const dragBrush = (b: Brush | null) => {
    setBrush(b);
    setBrushRev((r) => r + 1);
  };
  const clearFilters = () => {
    setChip("all");
    setLayerOn(ALL_LAYERS.map(() => true));
    dragBrush(null);
    search.clear();
  };
  const onSort = (key: MemorySort) => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: defaultDir(key) }));
  const review = () => {
    setChip("risk");
    setSort({ key: "strength", dir: "asc" });
    table.current?.focus();
  };

  const show = (id: string | null, replace: boolean) => navigate({ view: "health", projectKey, memoryId: id }, { replace });
  const close = useCallback(() => {
    navigate({ view: "health", projectKey, memoryId: null });
    const from = opener.current;
    if (from !== null) {
      const slot = pages.rowAt(from.index);
      if (slot.state === "ready" && slot.row.id === from.id) table.current?.setActive(from.index, false);
    }
    table.current?.focus();
  }, [projectKey, pages.rowAt]);

  const empty =
    pages.total !== null ? (
      <div>
        <p>No memories match</p>
        {hasFilters && (
          <button type="button" className="btn" onClick={clearFilters}>
            Clear filters
          </button>
        )}
      </div>
    ) : pages.error ? (
      <div role="alert">
        <span>{pages.error}</span>
        <button type="button" className="btn quiet" onClick={() => pages.retry(0)}>
          Retry
        </button>
      </div>
    ) : (
      <span role="status">Loading memories</span>
    );

  return (
    <section className="view" aria-labelledby="pv-name">
      {phone && <PhoneTop projectKey={projectKey} name={name} memoryId={memoryId} />}
      <header className="pv-head">
        <div className="pv-title">
          <h1 id="pv-name" className="ell">
            {name}
          </h1>
          {summary && (
            <div className="pv-meta">
              {summary.kind} · {plural(summary.live, "memory", "memories")} · last used {summary.lastRetrievedDays === null ? "never" : rel(summary.lastRetrievedDays)}
            </div>
          )}
        </div>
        {summary && summary.atRisk > 0 && (
          <button type="button" className="btn" onClick={review}>
            Review at-risk ({fmt(summary.atRisk)})
          </button>
        )}
      </header>
      <div className="pv-grid">
        {detail.data ? (
          <ScatterCard
            detail={detail.data}
            layerOn={layerOn}
            onLayer={setLayer}
            brush={brush}
            brushRev={brushRev}
            onDragBrush={dragBrush}
            onFieldBrush={setBrush}
            selected={selected}
            openId={memoryId}
            onOpen={(id) => {
              opener.current = null;
              show(id, false);
            }}
          />
        ) : (
          <section className="card" aria-label="Age and strength">
            {detail.error ? (
              <div className="state" role="alert">
                <h3>Could not load {name}</h3>
                <p>{errorMessage(detail.error)}</p>
                <button type="button" className="btn" onClick={detail.reload}>
                  Retry
                </button>
              </div>
            ) : (
              <div className="state" aria-busy="true">
                <span className="skel skel-map" />
              </div>
            )}
          </section>
        )}
        <DecayCard decay={pages.decay} />
        <section className="card tbl-card" aria-label="Memory list">
          <div className="card-h">
            <h2>Memories</h2>
            <div className="chips">
              {CHIPS.map((c) => (
                <button key={c.chip} type="button" className="chip" aria-pressed={chip === c.chip} onClick={() => setChip(c.chip)}>
                  {c.label}
                  <span className="n">{pages.counts ? fmt(pages.counts[c.chip]) : ""}</span>
                </button>
              ))}
              {q !== "" && (
                <button type="button" className="chip" aria-label={`Clear search ${q}`} onClick={search.clear}>
                  &ldquo;{q}&rdquo; &times;
                </button>
              )}
            </div>
            <span className="spacer" />
            {summary && pages.total !== null && (
              <span className="sub">
                {fmt(pages.total)} of {fmt(summary.live)}
              </span>
            )}
          </div>
          <MemoryTable
            pages={pages}
            count={pages.total ?? 0}
            sortKey={sort.key}
            sortDir={sort.dir}
            onSort={onSort}
            onToggleDir={() => setSort((s) => ({ ...s, dir: s.dir === "asc" ? "desc" : "asc" }))}
            resetKey={`${projectKey}${memoryPageQueryString(filters)}`}
            activeId={memoryId}
            onOpen={(index, id) => {
              opener.current = { index, id };
              show(id, false);
            }}
            onPreview={(index, id) => {
              opener.current = { index, id };
              if (!phone && drawerIsOpen()) show(id, true);
            }}
            empty={empty}
            ref={table}
          />
        </section>
      </div>
      <MemoryDrawer projectKey={projectKey} memoryId={memoryId} onClose={close} />
    </section>
  );
}
