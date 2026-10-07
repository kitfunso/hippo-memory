import { type ReactNode, createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type Controller, type OverlayEntry, type RowOverlay, type ToastState, createController, mergeOverlay } from "./actionController";
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
  const [entries, setEntries] = useState<readonly OverlayEntry[]>([]);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [ctl] = useState(() => createController({ setEntries, setToast, health: () => latest.current }));

  useEffect(() => {
    const onHide = () => ctl.commitPending(true);
    const onKey = (e: KeyboardEvent) => {
      if (!isUndoKey(e) || !ctl.canUndo()) return;
      e.preventDefault();
      ctl.undo();
    };
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) ctl.restored();
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
      window.removeEventListener("keydown", onKey);
      ctl.dispose();
    };
  }, [ctl]);

  const overlay = useMemo(() => mergeOverlay(entries), [entries]);
  const value = useMemo<ActionsValue>(() => ({ ...ctl, overlay, toast }), [ctl, overlay, toast]);
  return <ActionsContext.Provider value={value}>{children}</ActionsContext.Provider>;
}

/** The action state; throws outside `ActionsProvider` so a missing provider fails loudly. */
export function useActions(): ActionsValue {
  const value = useContext(ActionsContext);
  if (!value) throw new Error("useActions must be used inside ActionsProvider");
  return value;
}
