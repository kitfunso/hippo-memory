/** Number and time formatting shared by the Health view; ported from the mockup's utilities. */

/** Integer with thousands separators. */
export const fmt = (n: number): string => Math.round(n).toLocaleString("en-US");

/** Compact count: 1.2k, 34k, 1.5M. */
export const fmtK = (n: number): string =>
  n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "k" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n));

/** Share 0..1 as a percentage. */
export const pct = (x: number, digits = 1): string => (x * 100).toFixed(digits) + "%";

/** "1 memory" or "2 memories". */
export const plural = (n: number, word: string, words?: string): string => fmt(n) + " " + (n === 1 ? word : words ?? word + "s");

/** Display name of a project key before its summary is known: `p:hippo` is "hippo". */
export const keyLabel = (key: string): string => (key === "global" ? "Global" : key === "unassigned" ? "Unassigned" : key.replace(/^p:/, ""));

/** Display name of a project: Global and Unassigned are never shown by their stored names. */
export const projectLabel = (p: { name: string; kind: "project" | "global" | "unassigned" }): string =>
  p.kind === "global" ? "Global" : p.kind === "unassigned" ? "Unassigned" : p.name;

/** Clamps `v` into [a, b]. */
export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

/** Days as "today", "3d ago", "5w ago", "4mo ago", "1.2y ago". */
export function rel(days: number): string {
  if (days < 1) return "today";
  if (days < 14) return Math.floor(days) + "d ago";
  if (days < 60) return Math.floor(days / 7) + "w ago";
  if (days < 365) return Math.floor(days / 30) + "mo ago";
  return (days / 365).toFixed(1) + "y ago";
}

/** Seconds since `iso` as "just now", "42s ago", "5m ago", "3h ago" for the header's Updated label. */
export function relSince(iso: string, now: number): string {
  const secs = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}
