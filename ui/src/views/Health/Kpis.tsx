import type { Kpi, Overview } from "../../types";
import { fmt, fmtK, pct } from "./format";
import type { Range } from "./HealthContext";

const SPARK_W = 84;
const SPARK_H = 30;

/** The slice of a 90-point series that the range control selects, or null when there is nothing to draw. */
export function rangeSeries(series: number[] | null, range: number): number[] | null {
  if (!series || series.length < 2) return null;
  return series.slice(Math.max(0, series.length - 1 - range));
}

/** Delta line: total and projects are computed from the sliced series; the rest are the server's own text. */
export function deltaLine(kpi: Kpi, range: Range): string {
  const part = rangeSeries(kpi.series, range);
  if (!part) return kpi.delta;
  const gain = Math.max(0, Math.round(part[part.length - 1] - part[0]));
  if (kpi.id === "total") return `+${fmtK(gain)} created in the last ${range}d`;
  if (kpi.id === "projects") return `+${gain} new in ${range}d`;
  return kpi.delta;
}

function Spark({ series, label }: { series: number[]; label: string }) {
  const mn = Math.min(...series);
  const span = Math.max(...series) - mn || 1;
  const pts = series.map((v, i) => [2 + (i * (SPARK_W - 4)) / (series.length - 1), SPARK_H - 3 - ((v - mn) / span) * (SPARK_H - 8)]);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("");
  const last = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} role="img" aria-label={label}>
      <path d={`${d}L${last[0]} ${SPARK_H}L2 ${SPARK_H}Z`} fill="#eaf1fe" />
      <path d={d} fill="none" stroke="#2f6fed" strokeWidth="1.5" />
      <circle cx={last[0]} cy={last[1]} r="2.2" fill="#2f6fed" />
    </svg>
  );
}

function valueText(kpi: Kpi, data: Overview): string {
  if (kpi.id === "embeddingCoverage" && data.embeddingCoverage === null) return "unknown";
  return kpi.id === "atRiskShare" || kpi.id === "embeddingCoverage" ? pct(kpi.value) : fmt(kpi.value);
}

/** Five KPI cards; a card draws a sparkline only when the server recorded a series for it. */
export function Kpis({ data, range }: { data: Overview | null; range: Range }) {
  if (!data) {
    return (
      <div className="kpis" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="kpi">
            <div className="skel skel-l" />
            <div className="skel skel-v" />
            <div className="skel skel-d" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="kpis">
      {data.kpis.map((kpi) => {
        const part = rangeSeries(kpi.series, range);
        return (
          <div key={kpi.id} className="kpi">
            <div className="l">{kpi.label}</div>
            <div className="v">{valueText(kpi, data)}</div>
            <div className="d">{deltaLine(kpi, range)}</div>
            {part && <Spark series={part} label={`${kpi.label}, ${range}-day trend`} />}
          </div>
        );
      })}
    </div>
  );
}
