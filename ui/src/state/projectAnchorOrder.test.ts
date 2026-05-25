/**
 * v0.29 (E5 S1) — Tests for the persisted append-only project ordering.
 *
 * Coverage: load/save round-trip, append-only semantics, reference-equality
 * skip-save, shape validation (including the v2.1 inner-tuple corruption
 * case that golden-angle math is allergic to).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  loadProjectAnchorOrder,
  saveProjectAnchorOrder,
  reconcileProjectOrder,
  clearProjectAnchorOrder,
} from "./projectAnchorOrder.js";

const STORAGE_KEY = "hippo:projectAnchorOrder:v1";

describe("projectAnchorOrder", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    clearProjectAnchorOrder();
    vi.restoreAllMocks();
  });

  describe("loadProjectAnchorOrder", () => {
    it("returns empty when localStorage is empty", () => {
      const order = loadProjectAnchorOrder();
      expect(order.indexByTag.size).toBe(0);
      expect(order.nextIndex).toBe(0);
    });

    it("returns empty when localStorage value is non-JSON", () => {
      window.localStorage.setItem(STORAGE_KEY, "not json {{{");
      const order = loadProjectAnchorOrder();
      expect(order.indexByTag.size).toBe(0);
      expect(order.nextIndex).toBe(0);
    });

    it("returns empty when JSON shape lacks tags array", () => {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ nextIndex: 5 }));
      const order = loadProjectAnchorOrder();
      expect(order.indexByTag.size).toBe(0);
      expect(order.nextIndex).toBe(0);
    });

    it("returns empty when JSON shape lacks nextIndex number", () => {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ tags: [["path:hippo", 0]] }));
      const order = loadProjectAnchorOrder();
      expect(order.indexByTag.size).toBe(0);
    });

    it("returns empty when tags is present but non-iterable", () => {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ tags: "hello", nextIndex: 0 }));
      const order = loadProjectAnchorOrder();
      expect(order.indexByTag.size).toBe(0);
    });

    it("returns empty on inner-tuple corruption (v2.1: new Map(['hello']) silent corruption)", () => {
      // Single-element entries → Map gets {hello: undefined} → NaN downstream.
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ tags: [["hello"], ["world"]], nextIndex: 2 }),
      );
      const order = loadProjectAnchorOrder();
      expect(order.indexByTag.size).toBe(0);
      expect(order.nextIndex).toBe(0);
    });

    it("returns empty when an inner tuple has non-string key", () => {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ tags: [[42, 0]], nextIndex: 1 }),
      );
      const order = loadProjectAnchorOrder();
      expect(order.indexByTag.size).toBe(0);
    });

    it("returns empty when an inner tuple has non-finite number value", () => {
      // JSON.stringify({nextIndex: NaN}) → 'null'; we synthesize a value with infinite via raw.
      window.localStorage.setItem(
        STORAGE_KEY,
        '{"tags":[["path:hippo",null]],"nextIndex":1}',
      );
      const order = loadProjectAnchorOrder();
      expect(order.indexByTag.size).toBe(0);
    });
  });

  describe("saveProjectAnchorOrder + load round-trip", () => {
    it("round-trips a populated order", () => {
      const order = {
        indexByTag: new Map([
          ["path:hippo", 0],
          ["path:quantamental", 1],
          ["path:phzse", 2],
        ]),
        nextIndex: 3,
      };
      saveProjectAnchorOrder(order);
      const loaded = loadProjectAnchorOrder();
      expect(loaded.nextIndex).toBe(3);
      expect(loaded.indexByTag.get("path:hippo")).toBe(0);
      expect(loaded.indexByTag.get("path:quantamental")).toBe(1);
      expect(loaded.indexByTag.get("path:phzse")).toBe(2);
    });

    it("silent-skips save when localStorage throws (QuotaExceededError)", () => {
      // Spy on the prototype — jsdom's Storage proxy doesn't surface
      // instance-level spies, but prototype methods are reached via lookup.
      const setItemSpy = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(() => {
          throw new DOMException("Quota exceeded", "QuotaExceededError");
        });
      expect(() =>
        saveProjectAnchorOrder({ indexByTag: new Map([["x", 0]]), nextIndex: 1 }),
      ).not.toThrow();
      expect(setItemSpy).toHaveBeenCalled();
    });
  });

  describe("reconcileProjectOrder", () => {
    it("appends new tags with next-after-max index", () => {
      const start = {
        indexByTag: new Map([["path:hippo", 0]]),
        nextIndex: 1,
      };
      const result = reconcileProjectOrder(["path:hippo", "path:resona"], start);
      expect(result.indexByTag.get("path:hippo")).toBe(0);
      expect(result.indexByTag.get("path:resona")).toBe(1);
      expect(result.nextIndex).toBe(2);
    });

    it("keeps existing tags' indices stable (the core AC)", () => {
      const start = {
        indexByTag: new Map([
          ["path:hippo", 0],
          ["path:quantamental", 1],
          ["path:phzse", 2],
        ]),
        nextIndex: 3,
      };
      const result = reconcileProjectOrder(
        ["path:hippo", "path:quantamental", "path:phzse", "path:newcomer"],
        start,
      );
      expect(result.indexByTag.get("path:hippo")).toBe(0);
      expect(result.indexByTag.get("path:quantamental")).toBe(1);
      expect(result.indexByTag.get("path:phzse")).toBe(2);
      expect(result.indexByTag.get("path:newcomer")).toBe(3);
      expect(result.nextIndex).toBe(4);
    });

    it("returns SAME object reference when nothing changed (skip-save pattern)", () => {
      const start = {
        indexByTag: new Map([["path:hippo", 0]]),
        nextIndex: 1,
      };
      const result = reconcileProjectOrder(["path:hippo"], start);
      expect(result).toBe(start); // reference equality
    });

    it("returns SAME ref when current tags are a subset (deletions don't compact)", () => {
      const start = {
        indexByTag: new Map([["path:hippo", 0], ["path:zoom", 1]]),
        nextIndex: 2,
      };
      const result = reconcileProjectOrder(["path:hippo"], start);
      expect(result).toBe(start);
      expect(result.nextIndex).toBe(2); // slot 1 stays unused
      expect(result.indexByTag.has("path:zoom")).toBe(true);
    });

    it("assigns new tags alpha-sorted within a single batch", () => {
      const start = { indexByTag: new Map<string, number>(), nextIndex: 0 };
      const result = reconcileProjectOrder(
        ["path:zoom", "path:apple", "path:mango"],
        start,
      );
      expect(result.indexByTag.get("path:apple")).toBe(0);
      expect(result.indexByTag.get("path:mango")).toBe(1);
      expect(result.indexByTag.get("path:zoom")).toBe(2);
      expect(result.nextIndex).toBe(3);
    });
  });

  describe("clearProjectAnchorOrder", () => {
    it("removes the localStorage key", () => {
      saveProjectAnchorOrder({ indexByTag: new Map([["x", 0]]), nextIndex: 1 });
      expect(window.localStorage.getItem(STORAGE_KEY)).not.toBeNull();
      clearProjectAnchorOrder();
      expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    });
  });
});
