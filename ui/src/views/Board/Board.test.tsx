import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { Board } from "./Board.js";
import type { Card, CardDetail } from "../../types.js";

interface QueuedResponse {
  status: number;
  body: unknown;
}

function createRouter() {
  const queues = new Map<string, Array<QueuedResponse | Promise<Response>>>();
  const calls = new Map<string, number>();

  function queue(path: string, entry: QueuedResponse | Promise<Response>) {
    const existing = queues.get(path);
    if (existing) existing.push(entry);
    else queues.set(path, [entry]);
  }

  async function fetchStub(path: string): Promise<Response> {
    calls.set(path, (calls.get(path) ?? 0) + 1);
    const next = queues.get(path)?.shift();
    if (next === undefined) throw new Error(`no queued response for ${path}`);
    return next instanceof Promise ? next : new Response(JSON.stringify(next.body), { status: next.status });
  }

  return { queue, fetchStub, callCount: (path: string) => calls.get(path) ?? 0 };
}

function deferredResponse() {
  let resolveFn: ((value: Response) => void) | undefined;
  const promise = new Promise<Response>((res) => {
    resolveFn = res;
  });
  return { promise, resolve: (value: Response) => resolveFn?.(value) };
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

function makeDetail(card: Card, overrides: Partial<CardDetail> = {}): CardDetail {
  return {
    card,
    deps: { parents: [], children: [] },
    runs: [],
    comments: [],
    handoff: null,
    ...overrides,
  };
}

function renderBoard(router: ReturnType<typeof createRouter>) {
  vi.stubGlobal("fetch", router.fetchStub);
  return render(<Board viewSwitch={<div />} />);
}

describe("Board", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("B1: shows loading, then seven ordered column headings with counts", async () => {
    const router = createRouter();
    const cards = [makeCard({ id: "card_1", status: "backlog" }), makeCard({ id: "card_2", status: "ready" })];
    router.queue("/api/cards", { status: 200, body: { cards } });
    renderBoard(router);

    expect(screen.getByRole("status")).toHaveTextContent("loading cards");

    const headings = await screen.findAllByRole("heading", { level: 3 });
    expect(headings).toHaveLength(7);
    const order = ["backlog", "ready", "running", "blocked", "review", "done", "shelved"];
    headings.forEach((h, i) => expect(h.textContent).toContain(order[i]));
    expect(headings[0].textContent).toContain("1");
    expect(headings[2].textContent).toContain("0");
  });

  it("B2: a column with no cards shows none", async () => {
    const router = createRouter();
    router.queue("/api/cards", { status: 200, body: { cards: [makeCard({ status: "backlog" })] } });
    renderBoard(router);
    await screen.findAllByRole("heading", { level: 3 });
    expect(screen.getAllByText("none").length).toBeGreaterThan(0);
  });

  it("B3: empty cards shows no cards yet and the create hint", async () => {
    const router = createRouter();
    router.queue("/api/cards", { status: 200, body: { cards: [] } });
    renderBoard(router);
    expect(await screen.findByText("no cards yet")).toBeInTheDocument();
    expect(screen.getByText("hippo card create")).toBeInTheDocument();
  });

  it("B4: a 500 on first load shows the running hint", async () => {
    const router = createRouter();
    router.queue("/api/cards", { status: 500, body: { error: "Internal error" } });
    renderBoard(router);
    expect(await screen.findByText("is hippo dashboard running?")).toBeInTheDocument();
  });

  it("B5: tile meta reflects the lease predicate", async () => {
    const router = createRouter();
    const future = new Date(Date.now() + 3600_000).toISOString();
    const past = new Date(Date.now() - 3600_000).toISOString();
    const cards = [
      makeCard({ id: "card_future", status: "running", assigneeRuntime: "r1", leaseUntil: future }),
      makeCard({ id: "card_past", status: "running", assigneeRuntime: "r2", leaseUntil: past }),
      makeCard({ id: "card_null", status: "running", assigneeRuntime: "r3", leaseUntil: null }),
      makeCard({ id: "card_ready", status: "ready", assigneeRuntime: "r4" }),
    ];
    router.queue("/api/cards", { status: 200, body: { cards } });
    renderBoard(router);
    await screen.findAllByRole("heading", { level: 3 });

    expect(screen.getByText(/lease until/)).toBeInTheDocument();
    expect(screen.getAllByText(/lease expired/).length).toBe(2);
    expect(screen.getByText("r4")).toBeInTheDocument();
    expect(screen.getAllByText(/lease/i).length).toBe(3);
  });

  it("B6: opens the dialog on click, focuses esc, and Escape or the esc button both return focus to the tile", async () => {
    const router = createRouter();
    const card = makeCard({ id: "card_x", title: "Ship the thing", status: "done" });
    router.queue("/api/cards", { status: 200, body: { cards: [card] } });
    const detail = makeDetail(card, {
      deps: { parents: ["card_p"], children: ["card_c"] },
      runs: [{ id: 1, card: card.id, runtime: "r1", sessionId: null, started: "2026-01-01T00:00:00.000Z", ended: "2026-01-01T01:00:00.000Z", outcome: "success" }],
      comments: [{ id: 1, cardId: card.id, author: "a", body: "note", createdAt: "2026-01-01T00:00:00.000Z" }],
      handoff: { sessionId: "s1", summary: "handed off", updatedAt: "2026-01-01T00:00:00.000Z" },
    });
    router.queue(`/api/cards/${card.id}`, { status: 200, body: detail });
    renderBoard(router);

    const tile = await screen.findByRole("button", { name: /ship the thing/i });
    fireEvent.click(tile);

    const dialog = await screen.findByRole("dialog", { name: "Card details" });
    const escButton = within(dialog).getByRole("button", { name: "esc, close card details" });
    await waitFor(() => expect(escButton).toHaveFocus());

    expect(within(dialog).getByText("card_p")).toBeInTheDocument();
    expect(within(dialog).getByText("card_c")).toBeInTheDocument();
    expect(within(dialog).getByText(/run 1:/)).toBeInTheDocument();
    expect(within(dialog).getByText(/note/)).toBeInTheDocument();
    expect(within(dialog).getByText(/handed off/)).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(tile).toHaveFocus();

    router.queue(`/api/cards/${card.id}`, { status: 200, body: detail });
    fireEvent.click(tile);
    const dialog2 = await screen.findByRole("dialog", { name: "Card details" });
    const escButton2 = within(dialog2).getByRole("button", { name: "esc, close card details" });
    await waitFor(() => expect(escButton2).toHaveFocus());
    fireEvent.click(escButton2);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(tile).toHaveFocus();
  });

  it("B7: opening B while A is pending, then resolving A late, never shows A's data and focus stays on esc", async () => {
    const router = createRouter();
    const cardA = makeCard({ id: "card_a", title: "Card A" });
    const cardB = makeCard({ id: "card_b", title: "Card B" });
    router.queue("/api/cards", { status: 200, body: { cards: [cardA, cardB] } });
    renderBoard(router);

    const tileA = await screen.findByRole("button", { name: /card a/i });
    const tileB = screen.getByRole("button", { name: /card b/i });

    const pendingA = deferredResponse();
    router.queue(`/api/cards/${cardA.id}`, pendingA.promise);
    fireEvent.click(tileA);
    await screen.findByRole("dialog", { name: "Card details" });

    router.queue(`/api/cards/${cardB.id}`, { status: 200, body: makeDetail(cardB) });
    fireEvent.click(tileB);
    const dialog = await screen.findByRole("dialog", { name: "Card details" });
    await waitFor(() => expect(within(dialog).getByText("Card B")).toBeInTheDocument());

    pendingA.resolve(new Response(JSON.stringify(makeDetail(cardA)), { status: 200 }));
    await pendingA.promise;

    expect(within(dialog).queryByText("Card A")).not.toBeInTheDocument();
    expect(within(dialog).getByText("Card B")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "esc, close card details" })).toHaveFocus();
  });

  it("B8: a failed refresh keeps the cards and shows role alert", async () => {
    const router = createRouter();
    const card = makeCard({ id: "card_1", title: "Keep me" });
    router.queue("/api/cards", { status: 200, body: { cards: [card] } });
    renderBoard(router);
    await screen.findByRole("button", { name: /keep me/i });

    router.queue("/api/cards", { status: 500, body: { error: "boom" } });
    fireEvent.click(screen.getByRole("button", { name: /^refresh$/i }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /keep me/i })).toBeInTheDocument();
  });

  it("B9: refresh while the dialog is open refetches the card detail", async () => {
    const router = createRouter();
    const card = makeCard({ id: "card_1", title: "Reload me" });
    router.queue("/api/cards", { status: 200, body: { cards: [card] } });
    router.queue(`/api/cards/${card.id}`, { status: 200, body: makeDetail(card) });
    renderBoard(router);

    const tile = await screen.findByRole("button", { name: /reload me/i });
    fireEvent.click(tile);
    await screen.findByRole("dialog", { name: "Card details" });
    expect(router.callCount(`/api/cards/${card.id}`)).toBe(1);

    router.queue("/api/cards", { status: 200, body: { cards: [card] } });
    router.queue(`/api/cards/${card.id}`, { status: 200, body: makeDetail(card) });
    fireEvent.click(screen.getByRole("button", { name: /^refresh$/i }));

    await waitFor(() => expect(router.callCount(`/api/cards/${card.id}`)).toBe(2));
  });

  it("B12: a failed detail refresh shows an alert without losing the open card, a later good refresh clears it", async () => {
    const router = createRouter();
    const card = makeCard({ id: "card_1", title: "Keep me open" });
    router.queue("/api/cards", { status: 200, body: { cards: [card] } });
    router.queue(`/api/cards/${card.id}`, { status: 200, body: makeDetail(card) });
    renderBoard(router);

    const tile = await screen.findByRole("button", { name: /keep me open/i });
    fireEvent.click(tile);
    const dialog = await screen.findByRole("dialog", { name: "Card details" });
    await within(dialog).findByText("Keep me open");

    router.queue("/api/cards", { status: 200, body: { cards: [card] } });
    router.queue(`/api/cards/${card.id}`, { status: 500, body: { error: "boom" } });
    fireEvent.click(screen.getByRole("button", { name: /^refresh$/i }));

    expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
    expect(within(dialog).getByText("Keep me open")).toBeInTheDocument();

    router.queue("/api/cards", { status: 200, body: { cards: [card] } });
    router.queue(`/api/cards/${card.id}`, { status: 200, body: makeDetail(card) });
    fireEvent.click(screen.getByRole("button", { name: /^refresh$/i }));

    await waitFor(() => expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument());
  });

  it("B13: the dialog panel starts under the 48px board bar", async () => {
    const router = createRouter();
    const card = makeCard({ id: "card_1", title: "Panel offset" });
    router.queue("/api/cards", { status: 200, body: { cards: [card] } });
    router.queue(`/api/cards/${card.id}`, { status: 200, body: makeDetail(card) });
    renderBoard(router);

    const tile = await screen.findByRole("button", { name: /panel offset/i });
    fireEvent.click(tile);
    const dialog = await screen.findByRole("dialog", { name: "Card details" });

    expect(dialog).toHaveStyle({ top: "48px" });
  });

  it("B10: one card shows the singular count", async () => {
    const router = createRouter();
    router.queue("/api/cards", { status: 200, body: { cards: [makeCard()] } });
    renderBoard(router);
    expect(await screen.findByText("1 card")).toBeInTheDocument();
  });

  it("B10: two cards show the plural count", async () => {
    const router = createRouter();
    router.queue("/api/cards", { status: 200, body: { cards: [makeCard({ id: "card_1" }), makeCard({ id: "card_2" })] } });
    renderBoard(router);
    expect(await screen.findByText("2 cards")).toBeInTheDocument();
  });

  it("W2c: subtitle and count carry the phone-width hide class", async () => {
    const router = createRouter();
    router.queue("/api/cards", { status: 200, body: { cards: [makeCard()] } });
    renderBoard(router);
    expect(await screen.findByText("1 card")).toHaveClass("bar-decorative");
    expect(screen.getByText("brain observatory")).toHaveClass("bar-decorative");
  });

  it("B11: two refreshes where the first response resolves last shows the second response", async () => {
    const router = createRouter();
    const cardInitial = makeCard({ id: "card_1", title: "Initial" });
    router.queue("/api/cards", { status: 200, body: { cards: [cardInitial] } });
    renderBoard(router);
    await screen.findByRole("button", { name: /initial/i });

    const first = deferredResponse();
    const second = deferredResponse();
    router.queue("/api/cards", first.promise);
    fireEvent.click(screen.getByRole("button", { name: /^refresh$/i }));
    router.queue("/api/cards", second.promise);
    fireEvent.click(screen.getByRole("button", { name: /refreshing/i }));

    const cardSecond = makeCard({ id: "card_2", title: "Second" });
    second.resolve(new Response(JSON.stringify({ cards: [cardSecond] }), { status: 200 }));
    await screen.findByRole("button", { name: /second/i });

    const cardFirst = makeCard({ id: "card_3", title: "First stale" });
    first.resolve(new Response(JSON.stringify({ cards: [cardFirst] }), { status: 200 }));
    await first.promise;

    expect(screen.queryByRole("button", { name: /stale/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /second/i })).toBeInTheDocument();
  });
});
