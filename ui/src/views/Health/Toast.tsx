import { useEffect, useRef } from "react";
import { useActions } from "./actions";

/** The undo toast: a status region that holds its timer while the pointer or keyboard focus is inside it. */
export function Toast() {
  const { toast, undo, pause, resume } = useActions();
  const held = useRef({ hover: false, focus: false });
  const seq = toast?.seq;
  useEffect(() => {
    held.current = { hover: false, focus: false };
  }, [seq]);

  const hold = (key: "hover" | "focus", on: boolean) => {
    held.current[key] = on;
    if (held.current.hover || held.current.focus) pause();
    else resume();
  };

  return (
    <div
      className="toast"
      role="status"
      aria-live="polite"
      hidden={toast === null}
      onMouseEnter={() => hold("hover", true)}
      onMouseLeave={() => hold("hover", false)}
      onFocus={() => hold("focus", true)}
      onBlur={() => hold("focus", false)}
    >
      <span>{toast?.text}</span>
      {toast?.undo && (
        <button type="button" onClick={undo}>
          Undo
        </button>
      )}
    </div>
  );
}
