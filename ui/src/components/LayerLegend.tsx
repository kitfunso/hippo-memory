import { LAYER_COLORS } from "../engine/types.js";

const LAYERS: Array<{ key: keyof typeof LAYER_COLORS; label: string }> = [
  { key: "buffer", label: "buf" },
  { key: "episodic", label: "epi" },
  { key: "semantic", label: "sem" },
];

export function LayerLegend() {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 12,
      fontSize: 9,
      fontFamily: "var(--font-mono)",
      color: "var(--dim)",
      letterSpacing: "0.3px",
    }}>
      {LAYERS.map(({ key, label }) => (
        <div key={key} style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <div style={{
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: LAYER_COLORS[key],
            boxShadow: `0 0 4px ${LAYER_COLORS[key]}40`,
          }} />
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}
