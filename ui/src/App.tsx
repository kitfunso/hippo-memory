import { useState, useEffect, useCallback } from "react";
import type { Memory, Stats, Conflict, EmbeddingIndex } from "./types.js";
import { fetchMemories, fetchStats, fetchConflicts, fetchEmbeddings } from "./api/client.js";
import { LivingMap } from "./views/LivingMap/LivingMap.js";
import { INITIAL_FILTER_STATE, type FilterState, type Layer, type Confidence } from "./state/filterState.js";

/**
 * E5 S6 — Origin of the current freeze state. Lets the freeze button surface
 * an OS-source hint when applicable, and the title attribute revert to
 * standard wording when the user takes manual control.
 */
type FrozenOrigin = "os" | "user" | null;

type LoadState = "loading" | "ready" | "error";

const loadingStyles = `
  @keyframes hippo-float {
    0%, 100% { transform: translateY(0px); opacity: 0.4; }
    50% { transform: translateY(-6px); opacity: 1; }
  }
`;

export function App() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [embeddings, setEmbeddings] = useState<EmbeddingIndex>({});
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState("");

  // E2: shared filter state, prop-drilled to LivingMap + Header.
  const [filterState, setFilterState] = useState<FilterState>(INITIAL_FILTER_STATE);
  // E5 S6: track whether the current frozen state originated from OS or user.
  const [frozenOrigin, setFrozenOrigin] = useState<FrozenOrigin>(null);

  const setQuery = useCallback((query: string) => {
    setFilterState((prev) => ({ ...prev, query }));
  }, []);

  /** E5 S6: user-initiated freeze toggle. Clears OS-origin so the hint goes away. */
  const setFrozen = useCallback((frozen: boolean) => {
    setFilterState((prev) => ({ ...prev, frozen }));
    setFrozenOrigin("user");
  }, []);

  // E5 S6 — one-shot prefers-reduced-motion check on mount. Per plan-eng R1
  // HIGH #2: NOT subscribing to media query changes — the user's override
  // would otherwise be silently undone on every focus/blur event.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mq.matches) {
      setFilterState((prev) => ({ ...prev, frozen: true }));
      setFrozenOrigin("os");
    }
  }, []);

  // E3: per-filter setters for FilterPanel.
  const setLayers = useCallback((layers: Set<Layer>) => {
    setFilterState((prev) => ({ ...prev, layers }));
  }, []);

  const setStrengthRange = useCallback((strengthRange: [number, number]) => {
    setFilterState((prev) => ({ ...prev, strengthRange }));
  }, []);

  const setConfidences = useCallback((confidences: Set<Confidence>) => {
    setFilterState((prev) => ({ ...prev, confidences }));
  }, []);

  const setAgeMaxDays = useCallback((ageMaxDays: number | null) => {
    setFilterState((prev) => ({ ...prev, ageMaxDays }));
  }, []);

  // P4: reset everything except the user's freeze preference (rerunning
  // the simulation just because they cleared filters would surprise).
  const resetFilters = useCallback(() => {
    setFilterState((prev) => ({ ...INITIAL_FILTER_STATE, frozen: prev.frozen }));
  }, []);

  // v0.26.1: fadingOnly toggle wired from Header pill + FilterPanel toggle.
  const setFadingOnly = useCallback((fadingOnly: boolean) => {
    setFilterState((prev) => ({ ...prev, fadingOnly }));
  }, []);

  // v0.26.1 design-critic MED: auto-clear fadingOnly when at_risk drops to 0
  // (e.g. user pinned the last fading memory) so they're not stranded with
  // an empty canvas + drawer. aria-live announces the change for SR users.
  const [autoClearAnnouncement, setAutoClearAnnouncement] = useState("");
  useEffect(() => {
    if (filterState.fadingOnly && stats && stats.at_risk === 0) {
      setFilterState((prev) => ({ ...prev, fadingOnly: false }));
      setAutoClearAnnouncement("No more fading memories — fading filter cleared.");
    }
  }, [filterState.fadingOnly, stats?.at_risk]); // eslint-disable-line react-hooks/exhaustive-deps

  // E2 + E5: keyboard shortcut "F" toggles freeze. Per plan-eng R2 MED #3:
  // skip when target is inside the drawer (data-drawer="memory-list") so the
  // user's keyboard nav over rows doesn't accidentally freeze the scene.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.target instanceof HTMLElement && e.target.closest('[data-drawer="memory-list"]')) return;
      if (e.key === "f" || e.key === "F") setFrozen(!filterState.frozen);
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [filterState.frozen, setFrozen]);

  useEffect(() => {
    Promise.all([fetchMemories(), fetchStats(), fetchConflicts(), fetchEmbeddings()])
      .then(([m, s, c, e]) => {
        setMemories(m);
        setStats(s);
        setConflicts(c);
        setEmbeddings(e);
        setState("ready");
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setState("error");
      });
  }, []);

  if (state === "loading") {
    return (
      <div style={centerStyle} role="status" aria-live="polite">
        <style>{loadingStyles}</style>
        <div style={{ textAlign: "center" }}>
          <div style={{
            fontSize: 32,
            animation: "hippo-float 2.5s ease-in-out infinite",
            marginBottom: 16,
            filter: "saturate(0.7)",
          }}>
            🧠
          </div>
          <div style={{
            color: "var(--dim)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            letterSpacing: "2px",
          }}>
            loading memories
          </div>
        </div>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div style={centerStyle}>
        <div style={{ textAlign: "center", maxWidth: 320 }}>
          <div style={{
            color: "var(--red)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            marginBottom: 8,
          }}>
            {error}
          </div>
          <div style={{
            color: "var(--text-faint)",
            fontSize: 10,
            fontFamily: "var(--font-mono)",
          }}>
            is hippo dashboard running?
          </div>
        </div>
      </div>
    );
  }

  if (memories.length === 0) {
    return (
      <div style={centerStyle}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 32, marginBottom: 16, opacity: 0.5 }}>🧠</div>
          <div style={{
            color: "var(--dim)",
            fontSize: 12,
            fontFamily: "var(--font-mono)",
            marginBottom: 8,
          }}>
            no memories yet
          </div>
          <div style={{
            color: "var(--text-faint)",
            fontSize: 10,
            fontFamily: "var(--font-mono)",
          }}>
            run{" "}
            <span style={{ color: "var(--accent)" }}>hippo remember</span>
            {" "}to begin
          </div>
        </div>
      </div>
    );
  }

  return (
    // E5 fix: <main> landmark for Lighthouse landmark-one-main audit.
    <main style={{ width: "100%", height: "100%" }}>
      <LivingMap
        memories={memories}
        embeddings={embeddings}
        stats={stats}
        conflicts={conflicts}
        filterState={filterState}
        frozenOrigin={frozenOrigin}
        setQuery={setQuery}
        setFrozen={setFrozen}
        setLayers={setLayers}
        setStrengthRange={setStrengthRange}
        setConfidences={setConfidences}
        setAgeMaxDays={setAgeMaxDays}
        setFadingOnly={setFadingOnly}
        resetFilters={resetFilters}
      />
      {/* v0.26.1 — aria-live announcement for auto-clear (design-critic LOW). */}
      <div role="status" aria-live="polite" className="sr-only">{autoClearAnnouncement}</div>
    </main>
  );
}

const centerStyle: React.CSSProperties = {
  width: "100%",
  height: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};
