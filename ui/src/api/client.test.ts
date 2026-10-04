import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALL_LAYERS,
  ApiError,
  fetchMemoryPage,
  fetchOverview,
  fetchSearch,
  memoryPageQueryString,
  postForget,
  postPin,
  postResolve,
  postWrong,
} from "./client";

function stubFetch(body: Record<string, string | boolean> = {}, status = 200) {
  const fn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("memoryPageQueryString", () => {
  it("is empty for an empty query", () => {
    expect(memoryPageQueryString({})).toBe("");
  });

  it("omits layers when all four are on and never sends an empty list", () => {
    expect(memoryPageQueryString({ layers: ALL_LAYERS })).toBe("");
    expect(memoryPageQueryString({ layers: [] })).toBe("");
  });

  it("sends a subset of layers in a fixed order", () => {
    expect(memoryPageQueryString({ layers: ["trace", "buffer"] })).toBe("?layers=buffer%2Ctrace");
  });

  it("carries every documented param and drops defaults", () => {
    const qs = memoryPageQueryString({ offset: 100, limit: 100, sort: "strength", dir: "asc", chip: "risk", amin: 1, amax: 9, smin: 0.1, smax: 0.9, q: " ci " });
    const p = new URLSearchParams(qs);
    expect(Object.fromEntries(p)).toEqual({ offset: "100", limit: "100", sort: "strength", dir: "asc", chip: "risk", amin: "1", amax: "9", smin: "0.1", smax: "0.9", q: "ci" });
    expect(memoryPageQueryString({ chip: "all" })).toBe("");
  });

  it("drops a query shorter than two characters", () => {
    expect(memoryPageQueryString({ q: "a" })).toBe("");
    expect(memoryPageQueryString({ q: "  " })).toBe("");
  });

  it("keeps zero-valued numeric params", () => {
    expect(memoryPageQueryString({ offset: 0, amin: 0 })).toBe("?offset=0&amin=0");
  });
});

describe("fetchers", () => {
  it("fetchOverview adds fresh=1 only when asked", async () => {
    const fn = stubFetch();
    await fetchOverview();
    await fetchOverview({ fresh: true });
    expect(fn.mock.calls.map((c) => c[0])).toEqual(["/api/overview", "/api/overview?fresh=1"]);
  });

  it("fetchMemoryPage encodes the project key and appends the query", async () => {
    const fn = stubFetch();
    await fetchMemoryPage("p:my repo", { offset: 0, chip: "pinned" });
    expect(fn.mock.calls[0][0]).toBe("/api/projects/p%3Amy%20repo/memories?offset=0&chip=pinned");
  });

  it("fetchSearch encodes the query", async () => {
    const fn = stubFetch();
    await fetchSearch("a&b c");
    expect(fn.mock.calls[0][0]).toBe("/api/search?q=a%26b%20c");
  });

  it("throws an ApiError that carries the status and the server message", async () => {
    stubFetch({ error: "no such project" }, 404);
    const err = await fetchOverview().then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, message: "no such project" });
  });
});

describe("actions", () => {
  async function call(run: () => Promise<object>) {
    const fn = stubFetch({ ok: true });
    await run();
    const [url, init = {}] = fn.mock.calls[0];
    const body: object = JSON.parse(String(init.body));
    return { url: String(url), init, body };
  }

  it("every POST is JSON", async () => {
    for (const run of [() => postPin("m1", true), () => postWrong("m1"), () => postResolve(7, "m1"), () => postForget("m1")]) {
      const { init } = await call(run);
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({ "Content-Type": "application/json" });
    }
  });

  it("wrong and forget send an empty object", async () => {
    expect((await call(() => postWrong("m1"))).body).toEqual({});
    expect((await call(() => postForget("m1"))).body).toEqual({});
  });

  it("pin and resolve send their fields to the documented routes", async () => {
    const pin = await call(() => postPin("m 1", false));
    expect(pin.url).toBe("/api/memory/m%201/pin");
    expect(pin.body).toEqual({ pinned: false });
    const resolve = await call(() => postResolve(7, "m1"));
    expect(resolve.url).toBe("/api/conflicts/7/resolve");
    expect(resolve.body).toEqual({ keep: "m1" });
  });

  it("keepalive is set only when asked", async () => {
    expect((await call(() => postForget("m1"))).init.keepalive).toBe(false);
    expect((await call(() => postForget("m1", { keepalive: true }))).init.keepalive).toBe(true);
  });
});
