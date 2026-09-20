/** The dashboard's two views. */
export type View = "map" | "board";

const VIEWS = [
  { key: "map", label: "map", aria: "Memory map" },
  { key: "board", label: "board", aria: "Card board" },
] as const;

interface ViewSwitchProps {
  view: View;
  onChange: (view: View) => void;
  /** Focus the checked radio on mount; only true right after a switch, never on first load. */
  autoFocus?: boolean;
}

/** Map/board radiogroup: a two-way roving-tabindex switch, arrow keys toggle. */
export function ViewSwitch({ view, onChange, autoFocus }: ViewSwitchProps) {
  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    onChange(view === "map" ? "board" : "map");
  }

  return (
    <div role="radiogroup" aria-label="Dashboard view" onKeyDown={handleKeyDown} style={segmentedGroup}>
      {VIEWS.map(({ key, label, aria }) => {
        const checked = view === key;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={aria}
            tabIndex={checked ? 0 : -1}
            autoFocus={autoFocus && checked}
            onClick={() => {
              if (!checked) onChange(key);
            }}
            style={{
              ...segmentBtn,
              background: checked ? "rgba(196, 92, 60, 0.10)" : "transparent",
              color: checked ? "var(--accent)" : "var(--dim)",
              borderColor: checked ? "var(--accent)" : "var(--glass-border)",
              fontWeight: checked ? 500 : 400,
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

const segmentedGroup: React.CSSProperties = {
  display: "flex",
  gap: 4,
};

const segmentBtn: React.CSSProperties = {
  fontSize: 10,
  fontFamily: "var(--font-mono)",
  padding: "2px 8px",
  borderRadius: 3,
  cursor: "pointer",
  transition: "color 150ms ease, border-color 150ms ease, background 150ms ease",
  border: "1px solid",
};
