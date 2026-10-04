import { describe, expect, it } from "vitest";
import type { ScatterGrid, ScatterPoints } from "../../../types";
import { MARGIN, type Plot, ageAt, brushFromDrag, densityRgb, densityStep, hitCell, hitPoint, maxCell, maxLogFor, plotX, plotY, strengthAt } from "./scatter";

const plot: Plot = { W: 600, H: 240, maxLog: Math.log10(121) };

function luminance([r, g, b]: readonly number[]): number {
  const lin = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

describe("scatter geometry", () => {
  it("round-trips age and strength through pixels", () => {
    expect(ageAt(plot, plotX(plot, 30))).toBeCloseTo(30, 6);
    expect(strengthAt(plot, plotY(plot, 0.37))).toBeCloseTo(0.37, 6);
  });

  it("hitPoint finds the nearest visible point and skips layers that are off", () => {
    const data: ScatterPoints = { mode: "points", maxAgeDays: 90, points: [[10, 0.5, 1, 1], [10, 0.5, 2, 1]], ids: ["a", "b"] };
    expect(hitPoint(data, [true, true, true, true], plot, plotX(plot, 10), plotY(plot, 0.5))).toBe(0);
    expect(hitPoint(data, [true, false, true, true], plot, plotX(plot, 10), plotY(plot, 0.5))).toBe(1);
    expect(hitPoint(data, [true, true, true, true], plot, plotX(plot, 80), plotY(plot, 0.1))).toBe(-1);
  });

  it("brushFromDrag clamps to the plot and orders the corners", () => {
    const b = brushFromDrag(plot, plot.W + 50, plot.H + 50, -20, -20);
    expect(b.a0).toBeCloseTo(0, 6);
    expect(b.s0).toBeCloseTo(0, 6);
    expect(b.s1).toBeCloseTo(1, 6);
    expect(b.a1).toBeGreaterThan(b.a0);
    expect(MARGIN.l).toBeGreaterThan(0);
  });

  it("hitCell sums only the layers that are on and misses outside the plot", () => {
    const blank = () => Array.from({ length: 64 * 32 }, () => 0);
    const cells: ScatterGrid["cells"] = [blank(), blank(), blank(), blank()];
    const grid: ScatterGrid = { mode: "grid", maxAgeDays: 120, cols: 64, rows: 32, cells };
    const gp: Plot = { ...plot, maxLog: maxLogFor(grid) };
    const cell = hitCell(grid, [true, true, true, true], gp, MARGIN.l + 2, MARGIN.t + 2);
    expect(cell).not.toBeNull();
    cells[2][(cell?.row ?? 0) * 64 + (cell?.col ?? 0)] = 7;
    expect(hitCell(grid, [true, true, true, true], gp, MARGIN.l + 2, MARGIN.t + 2)?.count).toBe(7);
    expect(hitCell(grid, [true, true, false, true], gp, MARGIN.l + 2, MARGIN.t + 2)?.count).toBe(0);
    expect(maxCell(grid, [true, true, true, true])).toBe(7);
    expect(hitCell(grid, [true, true, true, true], gp, 2, 2)).toBeNull();
  });
});

describe("density colour", () => {
  it("the lowest non-empty step holds 3:1 against the white card", () => {
    const ratio = 1.05 / (luminance(densityRgb(0)) + 0.05);
    expect(ratio).toBeGreaterThanOrEqual(3);
  });

  it("steps rise with the count and a one-memory-max grid stays on the lowest step", () => {
    expect(densityStep(1, 1)).toBe(0);
    expect(densityStep(10, 100)).toBeCloseTo(0.5, 6);
    expect(densityStep(100, 100)).toBe(1);
  });
});
