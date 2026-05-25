/**
 * Parchment design tokens — single source of truth for the hybrid-v4 revamp.
 *
 * **DO NOT inline hex literals in scene.ts / particles.ts / types.ts.**
 * `scripts/check-token-drift.mjs` (lands in E1) will fail CI if any of the
 * legacy dark tokens reappear outside this file.
 *
 * Mirrors `ui/src/tokens.css` exactly. If you change a value here, change it
 * there too (or generate one from the other — see migration map for the
 * eventual codegen plan).
 *
 * Imported by:
 *   - ui/src/engine/scene.ts (replaces line ~70 `#050709`, line ~76 `0x7c5cff`, etc.)
 *   - ui/src/engine/types.ts (replaces `LAYER_COLORS`)
 *
 * (engine/particles.ts deleted in E4 — was dead code from a pre-Three.js draft.)
 */

// ---------------------------------------------------------------------------
// Hex string form — for CSS, DOM, THREE.Color('#...'), and template literals.
// ---------------------------------------------------------------------------

export const COLOR_BG = '#f4efe6'; // parchment body bg
export const COLOR_MAP_BG = '#faf7f2'; // lighter parchment for map area
export const COLOR_SURFACE = '#f0ebe0'; // tag bg, panel surface
export const COLOR_TEXT = '#3a3228'; // warm dark
export const COLOR_DIM = '#9b8e7e'; // warm grey, panel labels, muted text
export const COLOR_BORDER = '#c4b9a8'; // parchment border

export const COLOR_ACCENT = '#c45c3c'; // rust — selected, focus, primary CTA
export const COLOR_ACCENT_DIM = '#a04832'; // darker rust — conflicts, errors

// v0.28 (E2 real-edges) — shared-tag edge hairline color. Warm dark grey.
// Distinct from COLOR_DIM (panel-label color, lighter) AND from
// TAG_FALLBACK_COLOR (E1 untagged-memory swatch, neutral grey). Computed
// contrast vs COLOR_MAP_BG #faf7f2 = 4.58:1 for the swatch.
export const COLOR_EDGE = '#7a6f63';

// Layer tints (hybrid-v4 mockup lines 11-12)
export const COLOR_BUFFER = '#7c6caf'; // muted purple
export const COLOR_EPISODIC = '#4a8ca3'; // blue (NEW — was orange in legacy)
export const COLOR_SEMANTIC = '#5a8f6b'; // muted green

// Background gradient stops (replaces particles.ts L112-114)
export const COLOR_BG_GRADIENT_OUTER = '#f4efe6';
export const COLOR_BG_GRADIENT_MID = '#faf7f2';
export const COLOR_BG_GRADIENT_INNER = '#fffcf6';

// ---------------------------------------------------------------------------
// Numeric hex form — for THREE.js light constructors that take 0xRRGGBB.
// ---------------------------------------------------------------------------

export const COLOR_BG_HEX = 0xf4efe6;
export const COLOR_ACCENT_HEX = 0xc45c3c;
export const COLOR_BUFFER_HEX = 0x7c6caf;
export const COLOR_EPISODIC_HEX = 0x4a8ca3;
export const COLOR_SEMANTIC_HEX = 0x5a8f6b;
export const COLOR_CONFLICT_HEX = 0xa04832;
// v0.28 (E2 real-edges) — numeric form of COLOR_EDGE for THREE.LineBasicMaterial.
export const COLOR_EDGE_HEX = 0x7a6f63;
export const COLOR_GRID_HEX = 0xc4b9a8; // matches --border
export const COLOR_AMBIENT_LIGHT_HEX = 0xfffcf6; // warm parchment ambient

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

export const FONT_SERIF = 'Georgia, "Palatino Linotype", serif';
export const FONT_MONO = '"Consolas", "Monaco", monospace';

// ---------------------------------------------------------------------------
// Layer → color map (replaces LAYER_COLORS in types.ts)
// ---------------------------------------------------------------------------

export const LAYER_COLORS = {
  buffer: COLOR_BUFFER,
  episodic: COLOR_EPISODIC,
  semantic: COLOR_SEMANTIC,
} as const;

export const LAYER_COLORS_HEX = {
  buffer: COLOR_BUFFER_HEX,
  episodic: COLOR_EPISODIC_HEX,
  semantic: COLOR_SEMANTIC_HEX,
} as const;

// ---------------------------------------------------------------------------
// Spacing + radii (parchment aesthetic uses sharper corners than the dark
// observatory's 8px rounding).
// ---------------------------------------------------------------------------

export const RADIUS_SM = 2;
export const RADIUS_MD = 3;
export const RADIUS_LG = 6;

export const BORDER_W = 1;

// ---------------------------------------------------------------------------
// Cross-hatch texture (CSS-only; defined here for the rare case JS needs it)
// ---------------------------------------------------------------------------

export const TEXTURE_CROSS_HATCH = `repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(180,170,150,0.015) 2px, rgba(180,170,150,0.015) 3px), repeating-linear-gradient(90deg, transparent, transparent 2px, rgba(180,170,150,0.015) 2px, rgba(180,170,150,0.015) 3px)`;
