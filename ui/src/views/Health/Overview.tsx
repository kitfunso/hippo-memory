import { useCallback, useMemo, useRef, useState } from "react";
import type { Chip } from "../../api/client";
import { useIsPhone } from "../../hooks/useMediaQuery";
import { navigate } from "../../router";
import type { Overview as OverviewData } from "../../types";
import { treemapOrder } from "./canvas/squarify";
import { useHealth } from "./HealthContext";
import { Kpis } from "./Kpis";
import { OverviewTable } from "./OverviewTable";
import { PhoneTop } from "./PhoneTop";
import { Rail } from "./Rail";
import { type TreemapHandle, Treemap } from "./Treemap";

type Mode = "map" | "table";

function subtitle(data: OverviewData): string {
  const named = data.projects.filter((p) => p.kind === "project").length;
  const extra = [data.projects.some((p) => p.kind === "global") && "Global", data.projects.some((p) => p.kind === "unassigned") && "Unassigned"].filter(Boolean);
  return `${named} ${named === 1 ? "project" : "projects"}${extra.length ? `, plus ${extra.join(" and ")}` : ""}`;
}

function StateCard({ children, role }: { children: React.ReactNode; role?: "alert" | "status" }) {
  return (
    <div className="card grow">
      <div className="state" role={role}>
        {children}
      </div>
    </div>
  );
}

/** The Health overview: KPI strip, treemap or table of projects, and the attention rail. */
export function Overview() {
  const { overview, range, search, tip, treemap, intent } = useHealth();
  const [mode, setMode] = useState<Mode>("map");
  const zoom = useRef<TreemapHandle>(null);
  const phone = useIsPhone();
  const data = overview.data;
  const projects = useMemo(() => treemapOrder(data?.projects ?? []), [data]);

  const open = useCallback(
    (key: string, chip?: Chip) => {
      intent.current = chip ? { key, chip } : null;
      navigate({ view: "health", projectKey: key, memoryId: null });
    },
    [intent],
  );

  if (!data && overview.error) {
    return (
      <section className="view" aria-label="All projects">
        {phone && <PhoneTop projectKey={null} name="" memoryId={null} />}
        <StateCard role="alert">
          <h3>Could not load memories</h3>
          <p className="mono">{overview.error.message}</p>
          <p>Is hippo dashboard still running?</p>
          <button type="button" className="btn primary" onClick={overview.reload}>
            Retry
          </button>
        </StateCard>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="view" aria-label="All projects">
        {phone && <PhoneTop projectKey={null} name="" memoryId={null} />}
        <Kpis data={null} range={range} />
        <div className="ov-body">
          <div className="card">
            <div className="card-h">
              <h2>Projects</h2>
            </div>
            <div className="state" role="status">
              <div className="skel skel-map" aria-hidden="true" />
              <p>Loading memories</p>
            </div>
          </div>
          <Rail data={null} onOpen={open} />
        </div>
      </section>
    );
  }

  if (data.total === 0 || data.projects.length === 0) {
    return (
      <section className="view" aria-label="All projects">
        {phone && <PhoneTop projectKey={null} name="" memoryId={null} />}
        <Kpis data={data} range={range} />
        <StateCard>
          <p>
            No memories yet. Run <code className="mono">hippo remember</code> to add one.
          </p>
        </StateCard>
      </section>
    );
  }

  const noMatch = search.status === "done" && search.hits !== null && ![...search.hits.values()].some((n) => n > 0);
  return (
    <section className="view" aria-label="All projects">
      {phone && <PhoneTop projectKey={null} name="" memoryId={null} />}
      <Kpis data={data} range={range} />
      {overview.error && (
        <div className="notice" role="alert">
          <span>Could not refresh: {overview.error.message}</span>
          <button type="button" className="btn quiet" onClick={overview.reload}>
            Retry
          </button>
        </div>
      )}
      <div className="ov-body">
        <div className="card" id="mapcard">
          <div className="card-h">
            <h2>Projects</h2>
            <span className="sub ell">{subtitle(data)}</span>
            <span className="spacer" />
            {mode === "map" && (
              <div className="seg zoomctl" role="group" aria-label="Zoom">
                <button type="button" aria-label="Zoom out" onClick={() => zoom.current?.zoomBy(1 / 1.4)}>
                  &minus;
                </button>
                <button type="button" aria-label="Zoom in" onClick={() => zoom.current?.zoomBy(1.4)}>
                  +
                </button>
                <button type="button" className="fit" aria-label="Fit all projects" onClick={() => zoom.current?.fit()}>
                  Fit
                </button>
              </div>
            )}
            <div className="seg txt" role="group" aria-label="Project view">
              <button type="button" aria-pressed={mode === "map"} onClick={() => setMode("map")}>
                Map
              </button>
              <button type="button" aria-pressed={mode === "table"} onClick={() => setMode("table")}>
                Table
              </button>
            </div>
          </div>
          {mode === "map" ? (
            <div className="map-region">
              <Treemap ref={zoom} projects={projects} hits={search.hits} query={search.query} memory={treemap} tip={tip} onOpen={open} />
              {noMatch && (
                <div className="banner" role="status">
                  <span>No memories match &quot;{search.query}&quot;</span>
                  <button type="button" className="btn quiet" onClick={search.clear}>
                    Clear search
                  </button>
                </div>
              )}
            </div>
          ) : (
            <OverviewTable projects={projects} hits={search.hits} query={search.query} onOpen={open} />
          )}
        </div>
        <Rail data={data} onOpen={(key) => open(key)} />
      </div>
    </section>
  );
}
