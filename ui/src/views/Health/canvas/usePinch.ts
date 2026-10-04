import { type RefObject, useEffect } from "react";
import { type Camera, type PinchState, pinchOf, pinchStep } from "./camera";

/** Window after a pinch ends in which a finger lift is not a tap. */
export const PINCH_QUIET_MS = 350;

interface PinchHost {
  canvas: RefObject<HTMLCanvasElement | null>;
  getCam: () => Camera;
  getSize: () => { W: number; H: number };
  /** Applies the new camera and schedules a redraw. */
  setCam: (cam: Camera) => void;
  /** Time of the last pinch frame, for tap suppression. */
  pinchedAt: RefObject<number>;
}

/** Two-finger pinch via a non-passive touchmove, so a drifting pinch is never claimed as a page pan; one finger is left to scroll. */
export function usePinch({ canvas, getCam, getSize, setCam, pinchedAt }: PinchHost): void {
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    let state: PinchState | null = null;

    const point = (t: Touch) => {
      const r = el.getBoundingClientRect();
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    };
    const onMove = (e: TouchEvent) => {
      if (e.touches.length < 2) return;
      e.preventDefault();
      const a = point(e.touches[0]);
      const b = point(e.touches[1]);
      const next = pinchOf(a.x, a.y, b.x, b.y);
      if (state) {
        const { W, H } = getSize();
        setCam(pinchStep(getCam(), state, next, W, H).cam);
      }
      state = next;
      pinchedAt.current = performance.now();
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) state = null;
    };
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [canvas, getCam, getSize, setCam, pinchedAt]);
}
