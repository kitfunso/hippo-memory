import { useState, useEffect, useCallback } from "react";
import type { Memory, Stats, Conflict, EmbeddingIndex } from "./types.js";
import { fetchMemories, fetchStats, fetchConflicts, fetchEmbeddings } from "./api/client.js";
import { LivingMap } from "./views/LivingMap/LivingMap.js";
import { INITIAL_FILTER_STATE, type FilterState, type Layer, type Confidence } from "./state/filterState.js";

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

  const setQuery = useCallback((query: string) => {
    setFilterState((prev) => ({ ...prev, query }));
  }, []);

  const setFrozen = useCallback((frozen: boolean) => {
    setFilterState((prev) => ({ ...prev, frozen }));
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

  // E2: keyboard shortcut "F" toggles freeze (matches Header button's title hint).
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
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
      <div style={centerStyle}>
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
    <LivingMap
      memories={memories}
      embeddings={embeddings}
      stats={stats}
      conflicts={conflicts}
      filterState={filterState}
      setQuery={setQuery}
      setFrozen={setFrozen}
      setLayers={setLayers}
      setStrengthRange={setStrengthRange}
      setConfidences={setConfidences}
      setAgeMaxDays={setAgeMaxDays}
    />
  );
}

const centerStyle: React.CSSProperties = {
  width: "100%",
  height: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};
