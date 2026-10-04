import { clamp } from "../format";
import { prefersReducedMotion } from "../../../hooks/useMediaQuery";
import type { Rect } from "./squarify";

/** Treemap camera: layout point (wx, wy) draws at (wx * k + x, wy * k + y). */
export interface Camera {
  k: number;
  x: number;
  y: number;
}

/** The camera that shows the whole treemap. */
export const HOME_CAMERA: Camera = { k: 1, x: 0, y: 0 };

/** Largest zoom factor. */
export const MAX_ZOOM = 48;

/** Keeps the zoom in range and the map from drifting more than 30% of the view off screen. */
export function clampCam(cam: Camera, W: number, H: number): Camera {
  const k = clamp(cam.k, 1, MAX_ZOOM);
  const mx = W * 0.3;
  const my = H * 0.3;
  let x = clamp(cam.x, W - W * k - mx, mx);
  let y = clamp(cam.y, H - H * k - my, my);
  if (k === 1) {
    x = clamp(x, -mx, mx);
    y = clamp(y, -my, my);
  }
  return { k, x, y };
}

/** Zooms by factor `f` keeping the layout point under screen (sx, sy) fixed. */
export function zoomAt(cam: Camera, f: number, sx: number, sy: number, W: number, H: number): Camera {
  const k2 = clamp(cam.k * f, 1, MAX_ZOOM);
  const wx = (sx - cam.x) / cam.k;
  const wy = (sy - cam.y) / cam.k;
  return clampCam({ k: k2, x: sx - wx * k2, y: sy - wy * k2 }, W, H);
}

/** The camera that centres `t` and fits it in the view. */
export function fitCam(t: Rect, W: number, H: number): Camera {
  const k = Math.min(W / t.w, H / t.h);
  return { k, x: W / 2 - (t.x + t.w / 2) * k, y: H / 2 - (t.y + t.h / 2) * k };
}

/** A rect in layout space as drawn under `cam`. */
export function tileScreen(t: Rect, cam: Camera): Rect {
  return { x: t.x * cam.k + cam.x, y: t.y * cam.k + cam.y, w: t.w * cam.k, h: t.h * cam.k };
}

/** Two touch points of a pinch, reduced to what the camera needs. */
export interface PinchState {
  cx: number;
  cy: number;
  dist: number;
}

/** Centre and spread of two touch points, in canvas coordinates. */
export function pinchOf(ax: number, ay: number, bx: number, by: number): PinchState {
  return { cx: (ax + bx) / 2, cy: (ay + by) / 2, dist: Math.hypot(bx - ax, by - ay) };
}

/** The camera and pinch state after one pinch frame. */
export interface PinchResult {
  cam: Camera;
  state: PinchState;
}

/** One pinch frame: zoom by the spread ratio and pan with the centre; returns the next camera and state. */
export function pinchStep(cam: Camera, prev: PinchState, next: PinchState, W: number, H: number): PinchResult {
  if (prev.dist < 1 || next.dist < 1) return { cam, state: next };
  const k2 = clamp(cam.k * (next.dist / prev.dist), 1, MAX_ZOOM);
  const wx = (prev.cx - cam.x) / cam.k;
  const wy = (prev.cy - cam.y) / cam.k;
  return { cam: clampCam({ k: k2, x: next.cx - wx * k2, y: next.cy - wy * k2 }, W, H), state: next };
}

/** Cancels a running camera tween; returned by tweenCam. */
export type CancelTween = () => void;

/** Eases the camera to `to` about the view centre; instant under reduced motion. */
export function tweenCam(
  from: Camera,
  to: Camera,
  ms: number,
  W: number,
  H: number,
  onFrame: (c: Camera) => void,
  done?: () => void,
): CancelTween {
  if (prefersReducedMotion() || ms <= 0) {
    onFrame(to);
    done?.();
    return () => {};
  }
  const W2 = W / 2;
  const H2 = H / 2;
  const cf = { x: (W2 - from.x) / from.k, y: (H2 - from.y) / from.k };
  const ct = { x: (W2 - to.x) / to.k, y: (H2 - to.y) / to.k };
  const t0 = performance.now();
  let live = true;
  const step = (now: number) => {
    if (!live) return;
    const t = Math.min(1, (now - t0) / ms);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const k = Math.exp(Math.log(from.k) + (Math.log(to.k) - Math.log(from.k)) * e);
    const cx = cf.x + (ct.x - cf.x) * e;
    const cy = cf.y + (ct.y - cf.y) * e;
    onFrame({ k, x: W2 - cx * k, y: H2 - cy * k });
    if (t < 1) requestAnimationFrame(step);
    else done?.();
  };
  requestAnimationFrame(step);
  return () => {
    live = false;
  };
}
