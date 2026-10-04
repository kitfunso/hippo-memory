import type { MemorySort, SortDir } from "../../api/client";

/** Column labels of the memory table; the phone "Sort by" select lists the same keys in this order. */
export const SORT_LABELS = {
  content: "Memory",
  layer: "Layer",
  strength: "Strength",
  retrievals: "Uses",
  last: "Last used",
  age: "Age",
  confidence: "Confidence",
  scope: "Scope",
} satisfies Record<MemorySort, string>;

/** Sort keys in column order. */
export const SORT_KEYS: readonly MemorySort[] = ["content", "layer", "strength", "retrievals", "last", "age", "confidence", "scope"];

/** Narrows a column or option value to a sort key the server accepts. */
export function isSort(key: string): key is MemorySort {
  return SORT_KEYS.some((k) => k === key);
}

/** First direction a column sorts in: counts and age lead with the largest, the rest with the smallest. */
export const defaultDir = (key: MemorySort): SortDir => (key === "retrievals" || key === "age" ? "desc" : "asc");
