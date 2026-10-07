import { describe, expect, it } from "vitest";
import { type Route, parseHash, routeHash } from "./router";

describe("hash router", () => {
  const cases: [string, Route][] = [
    ["#/", { view: "health", projectKey: null, memoryId: null }],
    ["", { view: "health", projectKey: null, memoryId: null }],
    ["#/board", { view: "board" }],
    ["#/p/p%3Ahippo", { view: "health", projectKey: "p:hippo", memoryId: null }],
    ["#/p/global", { view: "health", projectKey: "global", memoryId: null }],
    ["#/p/p%3Ahippo/m/mem_1", { view: "health", projectKey: "p:hippo", memoryId: "mem_1" }],
  ];

  it.each(cases)("parses %s", (hash, route) => {
    expect(parseHash(hash)).toEqual(route);
  });

  it.each(cases.filter(([hash]) => hash !== ""))("round-trips %s", (hash, route) => {
    expect(routeHash(route)).toBe(hash);
  });

  it("falls back to the overview for unknown or malformed hashes", () => {
    const overview = { view: "health", projectKey: null, memoryId: null };
    expect(parseHash("#/nope")).toEqual(overview);
    expect(parseHash("#/p")).toEqual(overview);
    expect(parseHash("#/p/%E0%A4%A")).toEqual(overview);
    expect(parseHash("#/p/a/x/b")).toEqual(overview);
    expect(parseHash("#/board/extra")).toEqual(overview);
  });

  it("encodes keys that hold slashes or colons", () => {
    const route: Route = { view: "health", projectKey: "p:a/b", memoryId: "x y" };
    expect(parseHash(routeHash(route))).toEqual(route);
  });
});
