/** The dashboard's two views. */
export type View = "health" | "board";

const VIEWS = [
  { key: "health", label: "health", aria: "Memory health" },
  { key: "board", label: "board", aria: "Card board" },
] as const;

interface ViewSwitchProps {
  view: View;
  onChange: (view: View) => void;
}

/** Health/board radiogroup: a two-way roving-tabindex switch, arrow keys toggle and move focus to the newly checked radio. */
export function ViewSwitch({ view, onChange }: ViewSwitchProps) {
  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    e.currentTarget.querySelector<HTMLElement>('[role="radio"][aria-checked="false"]')?.focus();
    onChange(view === "health" ? "board" : "health");
  }

  return (
    <div role="radiogroup" aria-label="Dashboard view" onKeyDown={handleKeyDown} className="seg txt view-switch">
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
            onClick={() => {
              if (!checked) onChange(key);
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
