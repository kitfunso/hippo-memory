/**
 * E3 TagCloud. Derives tag frequencies from the visible memory subset,
 * sorts by frequency (descending), shows the top N (default 30). Clicking
 * a tag sets the search query to `tag:<name>` so it composes with the
 * existing search input.
 *
 * Click-to-filter syntax note: prefixing with `tag:` is a UX cue; the
 * existing search predicate already matches tags substring-style, so
 * `tag:foo` matches any memory with a tag containing "foo" — exact match
 * is good enough for the click-to-filter case.
 */

import type { Memory } from "../types.js";

interface TagCloudProps {
  memories: Memory[];
  visibleIds: Set<string>; // tags counted from filtered subset
  onTagClick: (tag: string) => void;
  topN?: number;
}

export function deriveTagFrequencies(memories: Memory[], visibleIds: Set<string>): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const m of memories) {
    if (visibleIds.size > 0 && !visibleIds.has(m.id)) continue;
    for (const tag of m.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  // Sort by count desc, then tag asc for deterministic ordering.
  return Array.from(counts.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
}

export function TagCloud({ memories, visibleIds, onTagClick, topN = 30 }: TagCloudProps) {
  const sorted = deriveTagFrequencies(memories, visibleIds);
  const top = sorted.slice(0, topN);

  if (top.length === 0) {
    return (
      <div style={{ marginBottom: 20 }}>
        <h3 style={panelTitle}>Tags</h3>
        <div style={{ fontSize: 11, color: "var(--text-faint)", fontStyle: "italic", fontFamily: "var(--font-serif)" }}>
          no tags in the current view
        </div>
      </div>
    );
  }

  const maxCount = top[0]![1];

  return (
    <div style={{ marginBottom: 20 }}>
      <h3 style={panelTitle}>
        Tags <span style={{ fontVariant: "normal", fontFamily: "var(--font-mono)", letterSpacing: 0, color: "var(--text-faint)", fontSize: 10 }}>
          ({sorted.length})
        </span>
      </h3>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {top.map(([tag, count]) => {
          // Scale font size 10-13 based on frequency for "cloud" feel.
          const weight = count / maxCount;
          const fontSize = 10 + weight * 3;
          return (
            <button
              key={tag}
              type="button"
              onClick={() => onTagClick(tag)}
              aria-label={`Filter to tag ${tag} (${count} memories)`}
              title={`${count} memories with tag "${tag}"`}
              style={{
                background: "var(--ink-faint)",
                color: "var(--text)",
                border: "1px solid var(--glass-border)",
                padding: "2px 8px",
                borderRadius: 3,
                fontSize,
                fontFamily: "var(--font-mono)",
                letterSpacing: "0.2px",
                cursor: "pointer",
                transition: "background 150ms ease, border-color 150ms ease",
              }}
            >
              {tag}
              <span style={{ marginLeft: 4, color: "var(--text-faint)", fontSize: Math.max(fontSize - 2, 9) }}>{count}</span>
            </button>
          );
        })}
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
