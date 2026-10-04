import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeProject } from "../../testing/fixtures";
import type { Kpi } from "../../types";
import { OverviewTable, sortProjects } from "./OverviewTable";
import { deltaLine, rangeSeries } from "./Kpis";

const ramp = Array.from({ length: 90 }, (_, i) => 100 + i);
const total: Kpi = { id: "total", label: "Total memories", value: 189, delta: "server text", series: ramp };

describe("KPI series", () => {
  it("slices the last N days plus today", () => {
    expect(rangeSeries(ramp, 7)).toEqual(ramp.slice(82));
    expect(rangeSeries(ramp, 90)).toHaveLength(90);
  });

  it("returns null for a missing or one-point series", () => {
    expect(rangeSeries(null, 30)).toBeNull();
    expect(rangeSeries([5], 30)).toBeNull();
  });

  it("computes the total and project deltas from the sliced series", () => {
    expect(deltaLine(total, 30)).toBe("+30 created in the last 30d");
    expect(deltaLine({ ...total, id: "projects" }, 7)).toBe("+7 new in 7d");
  });

  it("never shows a negative gain", () => {
    expect(deltaLine({ ...total, series: [50, 40] }, 7)).toBe("+0 created in the last 7d");
  });

  it("keeps the server text when there is no series or the KPI is not a count", () => {
    expect(deltaLine({ ...total, series: null }, 30)).toBe("server text");
    expect(deltaLine({ ...total, id: "openConflicts" }, 30)).toBe("server text");
  });
});

describe("sortProjects", () => {
  const a = makeProject("alpha", { live: 50, atRisk: 25 });
  const b = makeProject("beta", { live: 300, atRisk: 3, openConflicts: 2 });
  const c = makeProject("gamma", { live: 120, atRisk: 12, lastRetrievedDays: null });
  const dead = makeProject("dead", { live: 0, atRisk: 0 });
  const all = [a, b, c, dead];

  it("drops projects without live memories", () => {
    expect(sortProjects(all, null, "live", "desc").map((p) => p.name)).toEqual(["beta", "gamma", "alpha"]);
  });

  it("sorts by name ascending and by share descending", () => {
    expect(sortProjects(all, null, "name", "asc").map((p) => p.name)).toEqual(["alpha", "beta", "gamma"]);
    expect(sortProjects(all, null, "share", "desc").map((p) => p.name)).toEqual(["alpha", "gamma", "beta"]);
  });

  it("sorts a never-used project as the oldest", () => {
    expect(sortProjects(all, null, "lastUsed", "desc").map((p) => p.name)[0]).toBe("gamma");
  });

  it("keeps only search hits and breaks ties by key", () => {
    const hits = new Map([["p:beta", 4], ["p:alpha", 1], ["p:gamma", 0]]);
    expect(sortProjects(all, hits, "live", "desc").map((p) => p.name)).toEqual(["beta", "alpha"]);
    const tie = [makeProject("zed", { live: 10 }), makeProject("abe", { live: 10 })];
    expect(sortProjects(tie, null, "live", "desc").map((p) => p.name)).toEqual(["abe", "zed"]);
  });
});

describe("OverviewTable grid", () => {
  it("exposes the row total and header on the grid and a 1-based row index from 2", () => {
    const projects = [makeProject("alpha"), makeProject("beta", { live: 200 })];
    render(<OverviewTable projects={projects} hits={null} query="" onOpen={vi.fn()} />);
    const grid = screen.getByRole("grid", { name: "Projects table" });
    expect(grid).toHaveAttribute("aria-rowcount", "3");
    const rows = within(grid).getAllByRole("row");
    expect(rows[0]).toHaveAttribute("aria-rowindex", "1");
    const body = rows.slice(1).filter((r) => r.hasAttribute("aria-rowindex"));
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]).toHaveAttribute("aria-rowindex", "2");
    expect(within(grid).queryByRole("columnheader", { name: /team/i })).toBeNull();
  });

  it("shows the empty text when no row is left", () => {
    render(<OverviewTable projects={[makeProject("alpha")]} hits={new Map()} query="zzz" onOpen={vi.fn()} />);
    expect(screen.getByText('No projects match "zzz"')).toBeInTheDocument();
  });
});

describe("T10: token coverage", () => {
  const src = join(__dirname, "..", "..");

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return walk(path);
      return /\.(css|tsx?)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it("defines every var(--x) used under ui/src", () => {
    const files = walk(src);
    const defined = new Set<string>();
    const used = new Map<string, string>();
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(m[1]);
      for (const m of text.matchAll(/["'](--[a-z0-9-]+)["']/g)) defined.add(m[1]);
      for (const m of text.matchAll(/var\((--[a-z0-9-]+)/g)) if (!used.has(m[1])) used.set(m[1], file);
    }
    const missing = [...used].filter(([name]) => !defined.has(name)).map(([name, file]) => `${name} in ${file}`);
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(10);
  });

  it("defines every token in tokens.css exactly once at :root", () => {
    const text = readFileSync(join(src, "tokens.css"), "utf8");
    const names = [...text.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(10);
    expect(new Set(names).size).toBe(names.length);
  });
});
