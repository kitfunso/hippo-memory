/**
 * Tag-palette engine tests. Verifies the contract that plan-eng-critic
 * R1+R2+R3 locked in:
 *
 *   - buildPalette is pure + deterministic
 *   - top-N capped at min(topN, palette.length)
 *   - includePrefix / excludePrefix work in both modes
 *   - linear-probe collision resolution yields N unique colors for top-N
 *   - pickColorTag rule: shortest tag wins, alphabetical tiebreak
 *   - resolveColor returns fallback for memories with no qualifying tag
 *   - every TAG_PALETTE + PATH_PALETTE color has >= 4.5:1 contrast vs
 *     COLOR_MAP_BG (plan-design R3 LOW: AC10 covers both palettes)
 */

import { describe, it, expect } from "vitest";
import type { Memory } from "../types.js";
import {
  TAG_PALETTE,
  PATH_PALETTE,
  TAG_FALLBACK_COLOR,
  buildPalette,
  pickColorTag,
  pickShortestPathTag,
  resolveColor,
} from "./tagPalette.js";
import { contrastRatio } from "./contrast.js";
import { COLOR_MAP_BG } from "../tokens.js";

function mem(over: Partial<Memory> & { id: string }): Memory {
  return {
    id: over.id,
    content: over.content ?? `content-${over.id}`,
    tags: over.tags ?? [],
    layer: over.layer ?? "episodic",
    strength: over.strength ?? 0.5,
    half_life_days: over.half_life_days ?? 30,
    retrieval_count: over.retrieval_count ?? 1,
    schema_fit: over.schema_fit ?? 0.5,
    emotional_valence: over.emotional_valence ?? "neutral",
    confidence: over.confidence ?? "inferred",
    pinned: over.pinned ?? false,
    created: over.created ?? "2026-05-01T00:00:00Z",
    last_retrieved: over.last_retrieved ?? "2026-05-20T00:00:00Z",
    age_days: over.age_days ?? 10,
    projected_strength_7d: over.projected_strength_7d ?? 0.5,
    projected_strength_30d: over.projected_strength_30d ?? 0.5,
  };
}

describe("buildPalette", () => {
  const FIXTURE: Memory[] = [
    mem({ id: "1", tags: ["error", "path:hippo"] }),
    mem({ id: "2", tags: ["error", "path:hippo"] }),
    mem({ id: "3", tags: ["error", "openclaw"] }),
    mem({ id: "4", tags: ["rule", "path:quantamental"] }),
    mem({ id: "5", tags: ["openclaw"] }),
  ];

  it("returns top-N tags, capped at min(topN, palette.length)", () => {
    const result = buildPalette(FIXTURE, { excludePrefix: "path:", topN: 2, palette: TAG_PALETTE });
    expect(result.size).toBe(2);
    expect([...result.keys()]).toEqual(["error", "openclaw"]);
  });

  it("respects palette.length cap when topN > palette.length", () => {
    const result = buildPalette(FIXTURE, { excludePrefix: "path:", topN: 99, palette: TAG_PALETTE });
    expect(result.size).toBeLessThanOrEqual(TAG_PALETTE.length);
  });

  it("excludePrefix=path: excludes path:* tags from counts", () => {
    const result = buildPalette(FIXTURE, { excludePrefix: "path:", topN: 10, palette: TAG_PALETTE });
    for (const tag of result.keys()) {
      expect(tag.startsWith("path:")).toBe(false);
    }
  });

  it("includePrefix=path: counts only path:* tags", () => {
    const result = buildPalette(FIXTURE, { includePrefix: "path:", topN: 10, palette: PATH_PALETTE });
    for (const tag of result.keys()) {
      expect(tag.startsWith("path:")).toBe(true);
    }
    expect(result.has("path:hippo")).toBe(true);
    expect(result.has("path:quantamental")).toBe(true);
  });

  it("deterministic: same input → same output across calls", () => {
    const a = buildPalette(FIXTURE, { excludePrefix: "path:", topN: 10, palette: TAG_PALETTE });
    const b = buildPalette(FIXTURE, { excludePrefix: "path:", topN: 10, palette: TAG_PALETTE });
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it("linear-probe collision resolution: no two top-N tags share a color", () => {
    // Generate enough tags to exercise the hash collision path
    const tags: Memory[] = [];
    for (let i = 0; i < 50; i++) {
      tags.push(mem({ id: `m${i}`, tags: [`tag-${i.toString(36)}`] }));
    }
    const result = buildPalette(tags, { excludePrefix: "path:", topN: 10, palette: TAG_PALETTE });
    const colors = [...result.values()];
    const unique = new Set(colors);
    expect(unique.size).toBe(colors.length);
    expect(unique.size).toBe(10);
  });

  it("sort tiebreak: equal count → alphabetical", () => {
    // 3 tags each used by 1 memory → tied counts → alphabetical order
    const tied: Memory[] = [
      mem({ id: "a", tags: ["zebra"] }),
      mem({ id: "b", tags: ["apple"] }),
      mem({ id: "c", tags: ["mango"] }),
    ];
    const result = buildPalette(tied, { excludePrefix: "path:", topN: 2, palette: TAG_PALETTE });
    expect([...result.keys()]).toEqual(["apple", "mango"]);
  });
});

describe("pickColorTag", () => {
  it("tag mode: shortest non-path tag wins", () => {
    const m = mem({ id: "1", tags: ["a-longer-tag", "short", "another"] });
    expect(pickColorTag(m, "tag")).toBe("short");
  });

  it("tag mode: alphabetical tiebreak on equal length", () => {
    const m = mem({ id: "1", tags: ["zebra", "alpha"] });
    expect(pickColorTag(m, "tag")).toBe("alpha");
  });

  it("path mode: shortest path:* tag wins", () => {
    const m = mem({ id: "1", tags: ["path:hippo-memory", "path:hippo", "error"] });
    expect(pickColorTag(m, "path")).toBe("path:hippo");
  });

  it("path mode: returns null when no path:* tag", () => {
    const m = mem({ id: "1", tags: ["error", "rule"] });
    expect(pickColorTag(m, "path")).toBeNull();
  });

  it("tag mode: returns null when only path:* tags", () => {
    const m = mem({ id: "1", tags: ["path:hippo", "path:quantamental"] });
    expect(pickColorTag(m, "tag")).toBeNull();
  });

  it("empty tags: returns null in both modes", () => {
    const m = mem({ id: "1", tags: [] });
    expect(pickColorTag(m, "tag")).toBeNull();
    expect(pickColorTag(m, "path")).toBeNull();
  });
});

describe("resolveColor", () => {
  it("layer mode returns LAYER_COLORS[layer]", () => {
    const m = mem({ id: "1", layer: "episodic" });
    const color = resolveColor(m, "layer", new Map(), new Map());
    expect(color).toBe("#4a8ca3"); // COLOR_EPISODIC per tokens.ts
  });

  it("tag mode returns palette color when qualifying tag in map", () => {
    const m = mem({ id: "1", tags: ["error"] });
    const palette = new Map([["error", TAG_PALETTE[0]!]]);
    expect(resolveColor(m, "tag", palette, new Map())).toBe(TAG_PALETTE[0]!);
  });

  it("tag mode returns fallback when qualifying tag not in palette map", () => {
    const m = mem({ id: "1", tags: ["unmapped-tag"] });
    expect(resolveColor(m, "tag", new Map(), new Map())).toBe(TAG_FALLBACK_COLOR);
  });

  it("path mode returns path palette color", () => {
    const m = mem({ id: "1", tags: ["path:hippo"] });
    const pathPalette = new Map([["path:hippo", PATH_PALETTE[0]!]]);
    expect(resolveColor(m, "path", new Map(), pathPalette)).toBe(PATH_PALETTE[0]!);
  });

  it("returns fallback for memory with no tags", () => {
    const m = mem({ id: "1", tags: [] });
    expect(resolveColor(m, "tag", new Map(), new Map())).toBe(TAG_FALLBACK_COLOR);
    expect(resolveColor(m, "path", new Map(), new Map())).toBe(TAG_FALLBACK_COLOR);
  });

  it("never returns undefined or throws", () => {
    const m = mem({ id: "1", tags: [] });
    expect(() => resolveColor(m, "tag", new Map(), new Map())).not.toThrow();
    expect(resolveColor(m, "tag", new Map(), new Map())).toBeTypeOf("string");
  });
});

// Plan-design-critic R3 LOW: AC10 covers BOTH palettes vs parchment
describe("palette contrast (AC10)", () => {
  it("every TAG_PALETTE color has >= 4.5:1 contrast vs COLOR_MAP_BG", () => {
    for (const color of TAG_PALETTE) {
      const ratio = contrastRatio(color, COLOR_MAP_BG);
      expect(ratio, `${color} vs ${COLOR_MAP_BG}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("every PATH_PALETTE color has >= 4.5:1 contrast vs COLOR_MAP_BG", () => {
    for (const color of PATH_PALETTE) {
      const ratio = contrastRatio(color, COLOR_MAP_BG);
      expect(ratio, `${color} vs ${COLOR_MAP_BG}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("TAG_FALLBACK_COLOR has >= 4.5:1 contrast vs COLOR_MAP_BG", () => {
    expect(contrastRatio(TAG_FALLBACK_COLOR, COLOR_MAP_BG)).toBeGreaterThanOrEqual(4.5);
  });
});

/**
 * v0.29 (E5 HIGH-3) — pickShortestPathTag direct tests. The helper is now
 * exported (shared with computeProjectAnchors) so its contract is part of
 * the module surface, not just an internal pickColorTag detail.
 */
describe("pickShortestPathTag", () => {
  it("returns null when tag list is empty", () => {
    expect(pickShortestPathTag([])).toBeNull();
  });

  it("returns null when no path:* tag exists", () => {
    expect(pickShortestPathTag(["topic:foo", "agent:bar"])).toBeNull();
  });

  it("picks the shortest path tag", () => {
    expect(
      pickShortestPathTag(["path:hippo-tests", "path:hippo", "path:longer-name"]),
    ).toBe("path:hippo");
  });

  it("alpha tiebreak on equal-length path tags", () => {
    expect(pickShortestPathTag(["path:zzz", "path:aaa"])).toBe("path:aaa");
  });

  it("excludeSet filters out matched tags before picking", () => {
    expect(
      pickShortestPathTag(["path:skf_s", "path:hippo"], new Set(["path:skf_s"])),
    ).toBe("path:hippo");
  });

  it("excludeSet excluding all path tags returns null", () => {
    expect(
      pickShortestPathTag(["path:skf_s"], new Set(["path:skf_s"])),
    ).toBeNull();
  });

  it("undefined excludeSet behaves like empty (no exclusions)", () => {
    expect(pickShortestPathTag(["path:hippo"])).toBe("path:hippo");
  });
});
