import { type ReactNode, type Ref, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";

/** Imperative handle of the shared tip, so pointer moves update it without re-rendering its owner. */
export interface TipHandle {
  /** Shows `content` near viewport point (x, y); `closable` adds a close button (touch tips). */
  show(content: ReactNode, x: number, y: number, opts?: { closable?: boolean; onClose?: () => void }): void;
  /** Hides the tip and runs the `onClose` it was shown with. */
  hide(): void;
}

interface TipState {
  content: ReactNode;
  x: number;
  y: number;
  closable: boolean;
  onClose?: () => void;
}

interface TipProps {
  ref?: Ref<TipHandle>;
}

/** One floating tip for the whole Health view; keeps itself inside the viewport. */
export function Tip({ ref }: TipProps) {
  const [state, setState] = useState<TipState | null>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const box = useRef<HTMLDivElement>(null);
  const shown = useRef<TipState | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      show(content, x, y, opts) {
        shown.current = { content, x, y, closable: opts?.closable === true, onClose: opts?.onClose };
        setState(shown.current);
      },
      hide() {
        const onClose = shown.current?.onClose;
        shown.current = null;
        setState(null);
        onClose?.();
      },
    }),
    [],
  );

  useLayoutEffect(() => {
    if (!state || !box.current) return;
    const r = box.current.getBoundingClientRect();
    let left = state.x + 14;
    let top = state.y + 14;
    if (left + r.width > window.innerWidth - 8) left = state.x - r.width - 14;
    if (top + r.height > window.innerHeight - 8) top = state.y - r.height - 14;
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [state]);

  if (!state) return null;
  return (
    <div ref={box} id="tip" role="tooltip" className={state.closable ? "tip closable" : "tip"} style={{ left: pos.left, top: pos.top }}>
      {state.content}
      {state.closable && (
        <button
          type="button"
          className="tip-close"
          aria-label="Close tip"
          onClick={() => {
            const onClose = shown.current?.onClose;
            shown.current = null;
            setState(null);
            onClose?.();
          }}
        >
          &times;
        </button>
      )}
    </div>
  );
}
