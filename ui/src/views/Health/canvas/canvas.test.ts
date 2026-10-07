import { describe, expect, it } from "vitest";
import { makeProject } from "../../../testing/fixtures";
import { HOME_CAMERA, MAX_ZOOM, clampCam, fitCam, pinchOf, pinchStep, zoomAt } from "./camera";
import { riskColor } from "./riskColor";
import { layoutTiles, squarify, treemapOrder } from "./squarify";

describe("squarify", () => {
  it("fills the box exactly and keeps areas proportional to values", () => {
    const vals = [60, 30, 20, 10, 5];
    const rects = squarify(vals, 0, 0, 400, 200);
    const area = rects.reduce((s, r) => s + r.w * r.h, 0);
    expect(area).toBeCloseTo(400 * 200, 3);
    const total = vals.reduce((a, b) => a + b, 0);
    rects.forEach((r, i) => expect((r.w * r.h) / (400 * 200)).toBeCloseTo(vals[i] / total, 6));
  });

  it("keeps every rect inside the box", () => {
    for (const r of squarify([9, 8, 7, 3, 2, 1, 1], 10, 20, 300, 150)) {
      expect(r.x).toBeGreaterThanOrEqual(10 - 1e-9);
      expect(r.y).toBeGreaterThanOrEqual(20 - 1e-9);
      expect(r.x + r.w).toBeLessThanOrEqual(310 + 1e-9);
      expect(r.y + r.h).toBeLessThanOrEqual(170 + 1e-9);
    }
  });

  it("handles one value and no values", () => {
    expect(squarify([5], 0, 0, 100, 50)).toEqual([{ x: 0, y: 0, w: 100, h: 50 }]);
    expect(squarify([], 0, 0, 100, 50)).toEqual([]);
  });
});

describe("treemap layout", () => {
  const projects = [
    makeProject("small", { live: 10 }),
    makeProject("global", { live: 500, kind: "global", key: "global", name: "global" }),
    makeProject("big", { live: 300 }),
    makeProject("unassigned", { live: 40, kind: "unassigned", key: "unassigned", name: "unassigned" }),
    makeProject("empty", { live: 0, atRisk: 0 }),
  ];

  it("orders named projects by size, then Global, then Unassigned, and drops empty ones", () => {
    expect(treemapOrder(projects).map((p) => p.key)).toEqual(["p:big", "p:small", "global", "unassigned"]);
  });

  it("gives every live project one tile and indexes into the given array", () => {
    const ordered = treemapOrder(projects);
    const tiles = layoutTiles(ordered, 800, 400);
    expect(tiles.map((t) => t.key)).toEqual(ordered.map((p) => p.key));
    tiles.forEach((t, i) => expect(t.index).toBe(i));
  });

  it("returns no tiles for a degenerate box", () => {
    expect(layoutTiles(projects, 5, 5)).toEqual([]);
  });
});

describe("camera", () => {
  const W = 800;
  const H = 400;

  it("clamps zoom into [1, MAX_ZOOM]", () => {
    expect(clampCam({ k: 0.2, x: 0, y: 0 }, W, H).k).toBe(1);
    expect(clampCam({ k: 999, x: 0, y: 0 }, W, H).k).toBe(MAX_ZOOM);
  });

  it("zoomAt keeps the layout point under the cursor fixed", () => {
    const cam = zoomAt(HOME_CAMERA, 2, 300, 150, W, H);
    expect(cam.k).toBe(2);
    expect((300 - cam.x) / cam.k).toBeCloseTo(300, 6);
    expect((150 - cam.y) / cam.k).toBeCloseTo(150, 6);
  });

  it("fitCam centres a tile", () => {
    const t = { x: 100, y: 50, w: 200, h: 100 };
    const cam = fitCam(t, W, H);
    expect(cam.k).toBe(4);
    expect(t.x * cam.k + cam.x + (t.w * cam.k) / 2).toBeCloseTo(W / 2, 6);
    expect(t.y * cam.k + cam.y + (t.h * cam.k) / 2).toBeCloseTo(H / 2, 6);
  });
});

describe("pinchStep", () => {
  const W = 800;
  const H = 400;

  it("zooms by the spread ratio about the pinch centre", () => {
    const prev = pinchOf(300, 200, 500, 200);
    const next = pinchOf(250, 200, 550, 200);
    const { cam } = pinchStep(HOME_CAMERA, prev, next, W, H);
    expect(cam.k).toBeCloseTo(1.5, 6);
    expect((400 - cam.x) / cam.k).toBeCloseTo(400, 6);
  });

  it("pans with the centre when the spread is unchanged", () => {
    const prev = pinchOf(300, 200, 500, 200);
    const next = pinchOf(320, 200, 520, 200);
    const start = { k: 2, x: -100, y: -50 };
    const { cam } = pinchStep(start, prev, next, W, H);
    expect(cam.k).toBe(2);
    expect(cam.x).toBeCloseTo(-80, 6);
  });

  it("never zooms out past 1 or in past the maximum", () => {
    const wide = pinchOf(0, 0, 400, 0);
    const tight = pinchOf(0, 0, 4, 0);
    expect(pinchStep(HOME_CAMERA, wide, tight, W, H).cam.k).toBe(1);
    expect(pinchStep({ k: 40, x: 0, y: 0 }, tight, wide, W, H).cam.k).toBe(MAX_ZOOM);
  });

  it("ignores a degenerate pinch (fingers on the same point)", () => {
    const zero = pinchOf(10, 10, 10, 10);
    const { cam } = pinchStep({ k: 3, x: -10, y: -10 }, zero, pinchOf(0, 0, 100, 0), W, H);
    expect(cam).toEqual({ k: 3, x: -10, y: -10 });
  });
});

describe("riskColor", () => {
  it("clamps shares outside the ramp", () => {
    expect(riskColor(-1)).toEqual(riskColor(0));
    expect(riskColor(5)).toEqual(riskColor(0.6));
  });

  it("picks a light label ink on the darkest step and a dark one on the lightest", () => {
    expect(riskColor(0.6).ink).toBe("#ffffff");
    expect(riskColor(0).ink).toBe("#111827");
  });
});
