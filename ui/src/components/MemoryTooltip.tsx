import type { Memory } from "../types.js";
import type { ColorMode } from "../state/filterState.js";
import { LAYER_COLORS } from "../engine/types.js";

interface MemoryTooltipProps {
  memory: Memory;
  x: number;
  y: number;
  /**
   * v0.27 — current view's color mode. When "tag" or "path" AND colorTag
   * is non-null, the tooltip surfaces the color-driving tag as a non-color
   * channel for color-blind users.
   * Default "layer" preserves pre-v0.27 rendering (no extra line shown).
   */
  colorMode?: ColorMode;
  /**
   * v0.27 — the color-driving tag for this memory under the current mode
   * (derived by LivingMap via pickColorTag). Null when no qualifying tag.
   */
  colorTag?: string | null;
}

export function MemoryTooltip({ memory, x, y, colorMode = "layer", colorTag = null }: MemoryTooltipProps) {
  const preview = memory.content.length > 100 ? memory.content.slice(0, 100) + "…" : memory.content;
  const layerColor = LAYER_COLORS[memory.layer];
  const showColorTag = colorTag !== null && (colorMode === "tag" || colorMode === "path");

  return (
    <div style={{
      position: "fixed",
      left: x + 16,
      top: y - 12,
      background: "var(--glass-bg-strong)",
      backdropFilter: "blur(20px)",
      WebkitBackdropFilter: "blur(20px)",
      border: "1px solid var(--glass-border)",
      borderRadius: 12,
      padding: "12px 14px",
      maxWidth: 280,
      pointerEvents: "none" as const,
      zIndex: 100,
      boxShadow: `0 4px 24px var(--ink-shadow), 0 0 0 1px var(--glass-border)`,
    }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        marginBottom: 8,
      }}>
        <div style={{
          width: 5,
          height: 5,
          borderRadius: "50%",
          background: layerColor,
          boxShadow: `0 0 6px ${layerColor}60`,
        }} />
        <span style={{
          color: "var(--dim)",
          fontSize: 9,
          fontFamily: "var(--font-mono)",
          textTransform: "uppercase",
          letterSpacing: "0.5px",
        }}>
          {memory.layer}
        </span>
        <span style={{ color: "var(--text-faint)", fontSize: 9 }}>&middot;</span>
        <span style={{
          color: "var(--dim)",
          fontSize: 9,
          fontFamily: "var(--font-mono)",
        }}>
          {memory.strength.toFixed(2)} str
        </span>
      </div>
      {showColorTag && (
        <div style={{
          marginBottom: 6,
          color: "var(--dim)",
          fontSize: 9,
          fontFamily: "var(--font-mono)",
          letterSpacing: "0.4px",
        }}>
          color: {colorTag}
        </div>
      )}
      <div style={{
        color: "var(--text)",
        fontSize: 12,
        lineHeight: 1.5,
        fontFamily: "var(--font-body)",
      }}>
        {preview}
      </div>
      <div style={{
        marginTop: 8,
        display: "flex",
        gap: 8,
        color: "var(--text-faint)",
        fontSize: 9,
        fontFamily: "var(--font-mono)",
      }}>
        <span>{memory.retrieval_count} retrievals</span>
        <span>{memory.half_life_days}d half-life</span>
        <span>{memory.age_days}d old</span>
      </div>
    </div>
  );
}
