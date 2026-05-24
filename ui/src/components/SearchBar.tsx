import { useState } from "react";

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  memoryCount: number;
  matchCount: number | null;
}

export function SearchBar({ value, onChange, memoryCount, matchCount }: SearchBarProps) {
  const [focused, setFocused] = useState(false);

  return (
    <div style={{ position: "relative", width: 200 }}>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder="search…"
        style={{
          width: "100%",
          padding: "5px 10px",
          paddingRight: matchCount !== null ? 48 : 10,
          background: focused ? "var(--ink-faint)" : "var(--glass-bg)",
          border: focused ? "1px solid var(--accent-focus)" : "1px solid var(--glass-border)",
          borderRadius: 8,
          color: "var(--text)",
          fontSize: 11,
          fontFamily: "var(--font-mono)",
          outline: "none",
          boxSizing: "border-box" as const,
          transition: "all 200ms ease",
          letterSpacing: "0.3px",
        }}
      />
      {matchCount !== null && (
        <span style={{
          position: "absolute",
          right: 8,
          top: "50%",
          transform: "translateY(-50%)",
          color: "var(--text-faint)",
          fontSize: 9,
          fontFamily: "var(--font-mono)",
          pointerEvents: "none",
        }}>
          {matchCount}/{memoryCount}
        </span>
      )}
    </div>
  );
}
