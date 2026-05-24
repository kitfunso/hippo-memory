/**
 * WCAG 2.x relative-luminance + contrast-ratio helpers.
 *
 * Used by tagPalette to enforce >=4.5:1 contrast vs the parchment background
 * tokens (COLOR_MAP_BG #faf7f2 + COLOR_SURFACE #f0ebe0). v0.27 color-by-tag.
 *
 * Reference: WCAG 2.1 SC 1.4.3 / 1.4.11
 *   https://www.w3.org/TR/WCAG21/#contrast-minimum
 */

function parseHex(hex: string): [number, number, number] {
  const s = hex.startsWith("#") ? hex.slice(1) : hex;
  if (s.length !== 6) throw new Error(`Expected 6-char hex, got: ${hex}`);
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
    throw new Error(`Invalid hex: ${hex}`);
  }
  return [r, g, b];
}

/** Gamma-correct an sRGB channel to its linear-light value. */
function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance: 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  const lr = linearize(r);
  const lg = linearize(g);
  const lb = linearize(b);
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

/** WCAG contrast ratio between two colors. Returns a value in [1, 21]. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}
