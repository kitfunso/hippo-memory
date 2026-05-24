/**
 * E3 StatsPanel. Replaces the old dashboard's stats grid with a panel of
 * stat-rows (per-layer bars + counts) styled per hybrid-v4 mockup.
 */

import type { Stats } from "../types.js";
import { LAYER_COLORS } from "../engine/types.js";

interface StatsPanelProps {
  stats: Stats | null;
  totalVisible: number; // visible after filters
}

export function StatsPanel({ stats, totalVisible }: StatsPanelProps) {
  if (!stats) return null;

  const layerEntries: Array<["buffer" | "episodic" | "semantic", string]> = [
    ["buffer", "Buffer"],
    ["episodic", "Episodic"],
    ["semantic", "Semantic"],
  ];
  const maxLayerCount = Math.max(...Object.values(stats.by_layer), 1);

  return (
    <div style={{ marginBottom: 20 }}>
      <h3 style={panelTitle}>Memory layers</h3>

      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 12 }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 24, color: "var(--text)" }}>
          {totalVisible}
        </span>
        <span style={{ fontSize: 10, fontVariant: "small-caps", letterSpacing: "0.6px", color: "var(--dim)" }}>
          visible of {stats.total}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
        {layerEntries.map(([key, label]) => {
          const count = stats.by_layer[key] ?? 0;
          const color = LAYER_COLORS[key];
          const pct = (count / maxLayerCount) * 100;
          return (
            <div key={key} style={{ display: "grid", gridTemplateColumns: "78px 1fr 32px", alignItems: "center", gap: 10, fontSize: 11 }}>
              <span style={{ fontVariant: "small-caps", letterSpacing: "0.5px", color: "var(--text)" }}>{label}</span>
              <div style={{ height: 6, background: "var(--ink-faint)", borderRadius: 2, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 2, transition: "width 200ms ease" }} />
              </div>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--dim)", textAlign: "right" }}>{count}</span>
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--dim)" }}>
        <span>{stats.pinned} pinned</span>
        {stats.at_risk > 0 && <span style={{ color: "var(--accent)", fontWeight: 600 }}>{stats.at_risk} at risk</span>}
        <span>avg {stats.avg_strength.toFixed(2)}</span>
      </div>
    </div>
  );
}

const panelTitle = {
  fontSize: 11,
  fontVariant: "small-caps" as const,
  letterSpacing: "1px",
  fontWeight: 400,
  color: "var(--dim)",
  marginBottom: 10,
  paddingBottom: 6,
  borderBottom: "1px solid var(--glass-border)",
};
