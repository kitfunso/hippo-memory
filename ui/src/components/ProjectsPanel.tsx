/**
 * v0.29 (E5) — Sidebar Projects mini-panel.
 *
 * Lists path:* projects in their persistent-anchor-index order (first-seen
 * across user sessions, via localStorage). Each row shows a tiny SVG dot
 * at the project's anchor position so users can visually correlate a
 * Sidebar row to a cluster in the canvas. Click filters memories to that
 * project (via setQuery).
 *
 * Caps display at MAX_VISIBLE; "+N more" surfaces overflow count
 * (passive — no expand affordance in v1; v0.3.0+).
 */

import { LAYOUT_BOUND } from "../engine/forceLayout.js";

interface ProjectsPanelProps {
  /** Projects ordered by their anchor index (first-seen order). */
  projects: ReadonlyArray<{
    tag: string;
    count: number;
    anchor: { x: number; y: number };
  }>;
  /** Click handler: filter memories to that project (sets search query). */
  onSelectProject: (tag: string) => void;
}

const MAX_VISIBLE = 10;

// Mini SVG geometry — single source of truth, no duplicate cx/cy.
const MINI_SIZE = 20;
const MINI_CENTER = MINI_SIZE / 2;       // 10
const MINI_INNER_RADIUS = 5;             // dot lives within this
const MINI_OUTER_RADIUS = MINI_INNER_RADIUS + 2; // ring at 7

export function ProjectsPanel({ projects, onSelectProject }: ProjectsPanelProps) {
  if (projects.length === 0) return null;
  const visible = projects.slice(0, MAX_VISIBLE);
  const hiddenCount = Math.max(0, projects.length - MAX_VISIBLE);

  return (
    <div style={{ marginBottom: 20 }}>
      <h3 style={panelTitle}>Projects</h3>
      <div style={subtitleStyle}>(ordered by first-seen)</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {visible.map(({ tag, count, anchor }) => {
          // Map anchor.x ∈ [-LAYOUT_BOUND, +LAYOUT_BOUND] → screen-x ∈
          // [center - MINI_INNER_RADIUS, center + MINI_INNER_RADIUS].
          // Single coordinate system; v1's dead duplicate cx/cy lines gone.
          const dotX = MINI_CENTER + (anchor.x / LAYOUT_BOUND) * MINI_INNER_RADIUS;
          const dotY = MINI_CENTER + (anchor.y / LAYOUT_BOUND) * MINI_INNER_RADIUS;
          const projectName = tag.replace("path:", "");
          return (
            <button
              key={tag}
              type="button"
              onClick={() => onSelectProject(tag)}
              aria-label={`Filter to project ${projectName}, ${count} ${count === 1 ? "memory" : "memories"}`}
              className="project-row"
              style={projectRowStyle}
            >
              <svg
                width={MINI_SIZE}
                height={MINI_SIZE}
                aria-hidden={true}
                style={{ flexShrink: 0 }}
              >
                <circle
                  cx={MINI_CENTER}
                  cy={MINI_CENTER}
                  r={MINI_OUTER_RADIUS}
                  fill="none"
                  stroke="var(--border)"
                  strokeWidth={1}
                />
                <circle cx={dotX} cy={dotY} r={2} fill="var(--accent)" />
              </svg>
              <span style={projectNameStyle}>{projectName}</span>
              <span style={projectCountStyle}>{count}</span>
            </button>
          );
        })}
        {hiddenCount > 0 && (
          <div style={hiddenCountStyle}>+{hiddenCount} more</div>
        )}
      </div>
    </div>
  );
}

const panelTitle: React.CSSProperties = {
  fontSize: 11,
  fontVariant: "small-caps",
  letterSpacing: "1px",
  fontWeight: 400,
  color: "var(--dim)",
  marginBottom: 4,
  paddingBottom: 6,
  borderBottom: "1px solid var(--glass-border)",
};
const subtitleStyle: React.CSSProperties = {
  fontSize: 9,
  color: "var(--dim)",
  marginBottom: 8,
  fontStyle: "italic",
};
const projectRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "4px 6px",
  background: "transparent",
  border: "1px solid transparent",
  borderRadius: 3,
  cursor: "pointer",
  transition: "background 150ms ease",
  width: "100%",
  textAlign: "left",
};
const projectNameStyle: React.CSSProperties = {
  flex: 1,
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--text)",
};
const projectCountStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  color: "var(--dim)",
};
const hiddenCountStyle: React.CSSProperties = {
  fontSize: 9,
  color: "var(--dim)",
  textAlign: "center",
  marginTop: 4,
  fontStyle: "italic",
  opacity: 0.7,
};
