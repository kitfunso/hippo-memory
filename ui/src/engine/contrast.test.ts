/**
 * WCAG contrast helper tests. Cross-checked against the W3C contrast
 * checker for the parchment background tokens we care about.
 */

import { describe, it, expect } from "vitest";
import { relativeLuminance, contrastRatio } from "./contrast.js";

describe("relativeLuminance", () => {
  it("black is 0", () => {
    expect(relativeLuminance("#000000")).toBe(0);
  });

  it("white is 1", () => {
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 6);
  });

  it("parchment #faf7f2 is high (>= 0.93)", () => {
    expect(relativeLuminance("#faf7f2")).toBeGreaterThanOrEqual(0.93);
  });

  it("known mid-grey #808080", () => {
    expect(relativeLuminance("#808080")).toBeCloseTo(0.2159, 3);
  });

  it("throws on invalid hex", () => {
    expect(() => relativeLuminance("zzz")).toThrow();
    expect(() => relativeLuminance("#abc")).toThrow();
  });
});

describe("contrastRatio", () => {
  it("black on white is 21:1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
  });

  it("white on white is 1:1", () => {
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 6);
  });

  it("symmetric (order doesn't matter)", () => {
    const a = contrastRatio("#1e5a7d", "#faf7f2");
    const b = contrastRatio("#faf7f2", "#1e5a7d");
    expect(a).toBeCloseTo(b, 6);
  });

  it("#1e5a7d (deep blue) vs #faf7f2 (parchment) >= 4.5:1", () => {
    expect(contrastRatio("#1e5a7d", "#faf7f2")).toBeGreaterThanOrEqual(4.5);
  });

  it("#4d762a (darkened olive) vs #faf7f2 (parchment) >= 4.5:1", () => {
    expect(contrastRatio("#4d762a", "#faf7f2")).toBeGreaterThanOrEqual(4.5);
  });
});
