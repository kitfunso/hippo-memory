import { type ReactNode, createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type Controller, type RowOverlay, type ToastState, createController } from "./actionController";
import { useHealth } from "./HealthContext";

/** The controller's methods plus what views read: the row overlay and the toast. */
export interface ActionsValue extends Controller {
  overlay: ReadonlyMap<string, RowOverlay>;
  toast: ToastState | null;
}

const ActionsContext = createContext<ActionsValue | null>(null);

const TEXT_FIELD = /^(INPUT|TEXTAREA|SELECT)$/;

function isUndoKey(e: KeyboardEvent): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "z") return false;
  const t = e.target;
  return !(t instanceof HTMLElement && (t.isContentEditable || TEXT_FIELD.test(t.tagName)));
}

/** Holds the pending action, the row overlay and the toast above the views, so a pending action survives navigation. */
export function ActionsProvider({ children }: { children: ReactNode }) {
  const health = useHealth();
  const latest = useRef(health);
  useLayoutEffect(() => {
    latest.current = health;
  });
  const [overlay, setOverlay] = useState<ReadonlyMap<string, RowOverlay>>(() => new Map());
  const [toast, setToast] = useState<ToastState | null>(null);
  const [ctl] = useState(() => createController({ setOverlay, setToast, health: () => latest.current }));

  useEffect(() => {
    const onHide = () => ctl.commitPending(true);
    const onKey = (e: KeyboardEvent) => {
      if (!isUndoKey(e) || !ctl.canUndo()) return;
      e.preventDefault();
      ctl.undo();
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("keydown", onKey);
      ctl.dispose();
    };
  }, [ctl]);

  const value = useMemo<ActionsValue>(() => ({ ...ctl, overlay, toast }), [ctl, overlay, toast]);
  return <ActionsContext.Provider value={value}>{children}</ActionsContext.Provider>;
}

/** The action state; throws outside `ActionsProvider` so a missing provider fails loudly. */
export function useActions(): ActionsValue {
  const value = useContext(ActionsContext);
  if (!value) throw new Error("useActions must be used inside ActionsProvider");
  return value;
}
