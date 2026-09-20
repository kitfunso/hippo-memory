import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { App } from "./App.js";
import type { Card, Stats } from "./types.js";

interface QueuedResponse {
  status: number;
  body: unknown;
}

function createRouter() {
  const queues = new Map<string, Array<QueuedResponse | Promise<Response>>>();

  function queue(path: string, entry: QueuedResponse | Promise<Response>) {
    const existing = queues.get(path);
    if (existing) existing.push(entry);
    else queues.set(path, [entry]);
  }

  async function fetchStub(path: string): Promise<Response> {
    const next = queues.get(path)?.shift();
    if (next === undefined) throw new Error(`no queued response for ${path}`);
    return next instanceof Promise ? next : new Response(JSON.stringify(next.body), { status: next.status });
  }

  return { queue, fetchStub };
}

function makeStats(overrides: Partial<Stats> = {}): Stats {
  return {
    total: 0,
    pinned: 0,
    errors: 0,
    at_risk: 0,
    avg_strength: 0,
    avg_half_life: 0,
    by_layer: {},
    by_confidence: {},
    aged_out: 0,
    embedding_coverage: 0,
    open_conflicts: 0,
    ...overrides,
  };
}

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: "card_1",
    title: "Do the thing",
    status: "backlog",
    assigneeRuntime: null,
    repo: null,
    contract: null,
    budget: null,
    leaseUntil: null,
    heartbeatAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    tenantId: "default",
    scope: null,
    ...overrides,
  };
}

function queueEmptyMemories(router: ReturnType<typeof createRouter>) {
  router.queue("/api/memories", { status: 200, body: [] });
  router.queue("/api/stats", { status: 200, body: makeStats() });
  router.queue("/api/conflicts", { status: 200, body: [] });
  router.queue("/api/embeddings", { status: 200, body: {} });
}

describe("App", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("A1: empty memories shows the switch; switching to board and back to map both work", async () => {
    const router = createRouter();
    queueEmptyMemories(router);
    vi.stubGlobal("fetch", router.fetchStub);
    render(<App />);

    expect(await screen.findByText("no memories yet")).toBeInTheDocument();

    router.queue("/api/cards", { status: 200, body: { cards: [makeCard()] } });
    fireEvent.click(screen.getByRole("radio", { name: "Card board" }));
    expect(await screen.findByRole("radiogroup", { name: "Dashboard view" })).toBeInTheDocument();
    expect(await screen.findAllByRole("heading", { level: 3 })).toHaveLength(7);

    fireEvent.click(screen.getByRole("radio", { name: "Memory map" }));
    expect(await screen.findByText("no memories yet")).toBeInTheDocument();
  });

  it("A2: a memories fetch error shows the switch; switching still reaches board", async () => {
    const router = createRouter();
    router.queue("/api/memories", { status: 500, body: { error: "boom" } });
    router.queue("/api/stats", { status: 200, body: makeStats() });
    router.queue("/api/conflicts", { status: 200, body: [] });
    router.queue("/api/embeddings", { status: 200, body: {} });
    vi.stubGlobal("fetch", router.fetchStub);
    render(<App />);

    expect(await screen.findByText("is hippo dashboard running?")).toBeInTheDocument();

    router.queue("/api/cards", { status: 200, body: { cards: [] } });
    fireEvent.click(screen.getByRole("radio", { name: "Card board" }));
    expect(await screen.findByText("no cards yet")).toBeInTheDocument();
  });
});
