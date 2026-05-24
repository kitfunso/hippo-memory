/**
 * E4 BottomBar. Mockup-mandated chrome (mockup lines 470-478) that was
 * silently dropped from E2/E3 scope. Three regions:
 *
 * - left: layer legend (buf / epi / sem with colored dots)
 * - center: keyboard shortcuts (/ search, esc clear, f freeze)
 * - right: visual-property affordance key (size=retrievals, opacity=strength, lines=similarity)
 *
 * Per plan-design-critic HIGH: "users have no way to discover the keyboard
 * model or what node visual properties encode."
 */

import { LAYER_COLORS } from "../engine/types.js";

interface BottomBarProps {
  drawerOpen: boolean;
  onToggleDrawer: () => void;
  visibleCount: number;
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      display: "inline-block",
      fontFamily: "var(--font-mono)",
      fontSize: 9,
      padding: "1px 5px",
      background: "var(--ink-faint)",
      border: "1px solid var(--glass-border)",
      borderRadius: 3,
      color: "var(--text)",
      lineHeight: 1.3,
      marginRight: 3,
    }}>
      {children}
    </span>
  );
}

const LAYERS: Array<{ key: keyof typeof LAYER_COLORS; label: string }> = [
  { key: "buffer", label: "buffer" },
  { key: "episodic", label: "episodic" },
  { key: "semantic", label: "semantic" },
];

export function BottomBar({ drawerOpen, onToggleDrawer, visibleCount }: BottomBarProps) {
  return (
    <div style={{
      position: "absolute",
      bottom: 0,
      left: 0,
      right: 0,
      height: 36,
      background: "var(--glass-bg)",
      backdropFilter: "blur(20px)",
      WebkitBackdropFilter: "blur(20px)",
      borderTop: "1px solid var(--glass-border)",
      display: "flex",
      alignItems: "center",
      padding: "0 24px",
      gap: 24,
      fontSize: 10,
      fontFamily: "var(--font-mono)",
      color: "var(--dim)",
      zIndex: 25,
      pointerEvents: "auto",
    }}>
      {/* Left: layer legend */}
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        {LAYERS.map(({ key, label }) => (
          <div key={key} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{
              width: 6, height: 6, borderRadius: "50%",
              background: LAYER_COLORS[key], display: "inline-block",
            }} />
            <span>{label}</span>
          </div>
        ))}
      </div>

      <div style={{ flex: 1 }} />

      {/* Center: keyboard shortcuts + drawer toggle (L) */}
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <span><Kbd>/</Kbd> search</span>
        <span><Kbd>esc</Kbd> clear</span>
        <span><Kbd>f</Kbd> freeze</span>
        <span><Kbd>click</Kbd> open</span>
        <span
          role="button"
          tabIndex={0}
          onClick={onToggleDrawer}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggleDrawer();
            }
          }}
          aria-controls="memory-drawer"
          aria-expanded={drawerOpen}
          // E5 fix: aria-label STARTS with visible text to satisfy
          // Lighthouse label-content-name-mismatch (audit wants the
          // visible label substring to be inside the accessible name).
          aria-label={drawerOpen ? `L map, close memory list view` : `L list (${visibleCount}), open memory list view`}
          style={{
            cursor: "pointer",
            color: drawerOpen ? "var(--accent)" : "var(--dim)",
            transition: "color 150ms ease",
            userSelect: "none",
            // E5 fix: bump padding for Lighthouse target-size audit (>=24px).
            padding: "6px 4px",
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
          }}
        >
          <Kbd>L</Kbd> {drawerOpen ? "map" : `list (${visibleCount})`}
        </span>
      </div>

      <div style={{ flex: 1 }} />

      {/* Right: affordance key */}
      <div style={{
        fontStyle: "italic",
        fontFamily: "var(--font-serif)",
        fontSize: 11,
        color: "var(--dim)",
        letterSpacing: "0.2px",
      }}>
        size = retrievals · opacity = strength · lines = similarity
      </div>
    </div>
  );
}
