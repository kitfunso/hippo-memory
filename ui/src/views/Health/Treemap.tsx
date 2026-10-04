import { type ReactNode, type Ref, type RefObject, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../../hooks/useMediaQuery";
import type { Chip } from "../../api/client";
import type { ProjectSummary } from "../../types";
import { type Camera, type CancelTween, HOME_CAMERA, clampCam, fitCam, tileScreen, tweenCam, zoomAt } from "./canvas/camera";
import { clamp, fmt, pct, plural } from "./format";
import { PINCH_QUIET_MS, usePinch } from "./canvas/usePinch";
import { BAND_NAME, BAND_ORDER } from "./canvas/riskColor";
import { type BitmapCache, type Hit, drawTreemap, hitTest, makeHatch } from "./canvas/tiles";
import { type Tile, layoutTiles } from "./canvas/squarify";
import { clearFitCache } from "./canvas/text";
import type { TipHandle } from "./Tip";

/** Camera and selection kept across a drill into a project and back. */
export interface TreemapMemory {
  cam: Camera;
  selKey: string | null;
}

/** Zoom controls for the card header buttons. */
export interface TreemapHandle {
  zoomBy: (factor: number) => void;
  fit: () => void;
}

interface TreemapProps {
  /** Projects in treemap order (see treemapOrder). */
  projects: readonly ProjectSummary[];
  /** Per-project search hits by key, or null when no search is active. */
  hits: ReadonlyMap<string, number> | null;
  query: string;
  memory: RefObject<TreemapMemory>;
  tip: RefObject<TipHandle | null>;
  /** Open a project; `chip` is set when a band cell was chosen. */
  onOpen: (key: string, chip?: Chip) => void;
  ref?: Ref<TreemapHandle>;
}

interface Drag {
  x: number;
  y: number;
  cx: number;
  cy: number;
  moved: boolean;
}

interface Live {
  W: number;
  H: number;
  dpr: number;
  tiles: Tile[];
  version: number;
  cam: Camera;
  hover: number;
  sel: number;
  drag: Drag | null;
  tap: { x: number; y: number } | null;
  raf: number;
  tween: CancelTween | null;
  tipTarget: string | null;
  drilling: boolean;
  hatch: CanvasPattern | null;
}

interface HitAt {
  hit: Hit;
  mx: number;
  my: number;
}

const BAND_CHIP: readonly Chip[] = ["pinned", "all", "all", "risk"];
const TAP_SLOP = 10;
const ARROWS = new Map<string, readonly [number, number]>([
  ["ArrowRight", [1, 0]],
  ["ArrowLeft", [-1, 0]],
  ["ArrowDown", [0, 1]],
  ["ArrowUp", [0, -1]],
]);

function tileTip(p: ProjectSummary, query: string, hit: number | undefined): ReactNode {
  return (
    <>
      <b>{p.kind === "global" ? "Global (no project)" : p.name}</b>
      <br />
      <span className="m">
        {fmt(p.live)} memories &middot; {pct(p.share)} at risk
        <br />
        {plural(p.openConflicts, "open conflict")} &middot; {pct(p.live ? p.embedded / p.live : 0, 0)} embedded
      </span>
      {hit !== undefined && (
        <>
          <br />
          <span className="m">
            {plural(hit, "match", "matches")} for &quot;{query}&quot;
          </span>
        </>
      )}
    </>
  );
}

function cellTip(p: ProjectSummary, band: number): ReactNode {
  return (
    <>
      <b>{BAND_NAME[band]}</b>
      <span className="m">
        : {plural(p.bands[BAND_ORDER[band]], "memory", "memories")} in {p.name}
      </span>
    </>
  );
}

/** Canvas treemap of projects: area is memory count, colour is at-risk share; React never re-renders on pointer moves. */
export function Treemap({ projects, hits, query, memory, tip, onOpen, ref }: TreemapProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [announce, setAnnounce] = useState("");
  const bitmaps = useRef<BitmapCache>(new Map());
  const pinchedAt = useRef(0);
  const s = useRef<Live>({
    W: 0,
    H: 0,
    dpr: 1,
    tiles: [],
    version: 0,
    cam: memory.current.cam,
    hover: -1,
    sel: -1,
    drag: null,
    tap: null,
    raf: 0,
    tween: null,
    tipTarget: null,
    drilling: false,
    hatch: null,
  });
  const live = useRef({ projects, hits, query, onOpen });
  useLayoutEffect(() => {
    live.current = { projects, hits, query, onOpen };
  });

  const draw = useCallback(() => {
    const ctx = cv.current?.getContext("2d");
    if (!ctx) return;
    const m = s.current;
    if (!m.hatch) m.hatch = makeHatch(ctx);
    drawTreemap({
      ctx,
      W: m.W,
      H: m.H,
      dpr: m.dpr,
      tiles: m.tiles,
      projects: live.current.projects,
      cam: m.cam,
      hover: m.hover,
      sel: m.sel,
      hits: live.current.hits,
      bitmaps: bitmaps.current,
      version: m.version,
      hatch: m.hatch,
    });
  }, []);

  const schedule = useCallback(() => {
    const m = s.current;
    if (m.raf) return;
    m.raf = requestAnimationFrame(() => {
      m.raf = 0;
      draw();
    });
  }, [draw]);

  const setCam = useCallback(
    (cam: Camera) => {
      s.current.cam = cam;
      schedule();
    },
    [schedule],
  );
  const getCam = useCallback(() => s.current.cam, []);
  const getSize = useCallback(() => ({ W: s.current.W, H: s.current.H }), []);
  usePinch({ canvas: cv, getCam, getSize, setCam, pinchedAt });

  const relayout = useCallback(() => {
    const m = s.current;
    m.tiles = layoutTiles(live.current.projects, m.W, m.H);
    m.version++;
    m.sel = m.tiles.findIndex((t) => t.key === memory.current.selKey);
    m.cam = clampCam(m.cam, m.W, m.H);
    schedule();
  }, [memory, schedule]);

  const resize = useCallback(() => {
    const el = wrap.current;
    const canvas = cv.current;
    if (!el || !canvas) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const m = s.current;
    const dpr = window.devicePixelRatio || 1;
    if (Math.abs(r.width - m.W) < 0.5 && Math.abs(r.height - m.H) < 0.5 && dpr === m.dpr && m.tiles.length > 0) return;
    m.W = r.width;
    m.H = r.height;
    m.dpr = dpr;
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    relayout();
  }, [relayout]);

  const hideTip = useCallback(() => {
    s.current.tipTarget = null;
    tip.current?.hide();
  }, [tip]);

  const open = useCallback(
    (key: string, chip?: Chip) => {
      const m = s.current;
      memory.current.selKey = key;
      memory.current.cam = m.cam;
      m.drilling = true;
      const t = m.tiles.find((x) => x.key === key);
      hideTip();
      if (t && !prefersReducedMotion()) {
        m.tween?.();
        m.tween = tweenCam(m.cam, fitCam(t, m.W, m.H), 300, m.W, m.H, setCam, () => live.current.onOpen(key, chip));
      } else {
        live.current.onOpen(key, chip);
      }
    },
    [hideTip, memory, setCam],
  );

  useImperativeHandle(
    ref,
    () => ({
      zoomBy: (f) => setCam(zoomAt(s.current.cam, f, s.current.W / 2, s.current.H / 2, s.current.W, s.current.H)),
      fit: () => {
        const m = s.current;
        m.tween?.();
        m.tween = tweenCam(m.cam, HOME_CAMERA, 240, m.W, m.H, setCam);
      },
    }),
    [setCam],
  );

  useEffect(() => {
    const el = wrap.current;
    const canvas = cv.current;
    if (!el || !canvas) return;
    const m = s.current;
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      setCam(zoomAt(m.cam, Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top, m.W, m.H));
      hideTip();
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    // A window dragged to a screen with another density changes dpr without resizing the box.
    let density: MediaQueryList | undefined;
    const onDensity = () => {
      resize();
      watchDensity();
    };
    const watchDensity = () => {
      density?.removeEventListener("change", onDensity);
      density = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      density?.addEventListener("change", onDensity);
    };
    watchDensity();
    void document.fonts?.ready.then(() => {
      clearFitCache();
      schedule();
    });
    return () => {
      ro.disconnect();
      canvas.removeEventListener("wheel", onWheel);
      density?.removeEventListener("change", onDensity);
      if (m.raf) cancelAnimationFrame(m.raf);
      m.tween?.();
      if (!m.drilling) memory.current.cam = m.cam;
    };
  }, [resize, setCam, hideTip, schedule, memory]);

  useEffect(() => {
    relayout();
  }, [projects, relayout]);

  useEffect(() => {
    schedule();
  }, [hits, schedule]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const inside = e.target instanceof Element && e.target.closest("canvas, .tip");
      if (s.current.tipTarget && !inside) hideTip();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [hideTip]);

  const hitAt = (e: { clientX: number; clientY: number }): HitAt => {
    const r = cv.current!.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const m = s.current;
    return { hit: hitTest({ tiles: m.tiles, projects: live.current.projects, cam: m.cam, bitmaps: bitmaps.current }, mx, my), mx, my };
  };

  const showFor = (hit: Hit, x: number, y: number, closable: boolean) => {
    const m = s.current;
    if (hit.ti < 0) {
      hideTip();
      return;
    }
    const p = live.current.projects[m.tiles[hit.ti].index];
    const content = hit.band >= 0 ? cellTip(p, hit.band) : tileTip(p, live.current.query, live.current.hits?.get(p.key));
    tip.current?.show(content, x, y, { closable, onClose: () => (m.tipTarget = null) });
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const m = s.current;
    if (e.pointerType === "touch") {
      m.tap = { x: e.clientX, y: e.clientY };
      return;
    }
    if (e.button !== 0) return;
    cv.current!.setPointerCapture?.(e.pointerId);
    m.drag = { x: e.clientX, y: e.clientY, cx: m.cam.x, cy: m.cam.y, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === "touch") return;
    const m = s.current;
    const d = m.drag;
    if (d) {
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (d.moved || Math.hypot(dx, dy) > 4) {
        d.moved = true;
        cv.current!.style.cursor = "grabbing";
        hideTip();
        setCam(clampCam({ ...m.cam, x: d.cx + dx, y: d.cy + dy }, m.W, m.H));
        return;
      }
    }
    const { hit } = hitAt(e);
    if (hit.ti !== m.hover) {
      m.hover = hit.ti;
      schedule();
    }
    showFor(hit, e.clientX, e.clientY, false);
    cv.current!.style.cursor = hit.ti >= 0 ? "pointer" : "grab";
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const m = s.current;
    if (e.pointerType === "touch") {
      const tap = m.tap;
      m.tap = null;
      if (!tap || Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > TAP_SLOP) return;
      if (performance.now() - pinchedAt.current < PINCH_QUIET_MS) return;
      const { hit } = hitAt(e);
      if (hit.ti < 0) {
        hideTip();
        return;
      }
      const t = m.tiles[hit.ti];
      const target = `${t.key}:${hit.band}`;
      if (m.tipTarget === target) {
        hideTip();
        open(t.key, hit.band >= 0 ? BAND_CHIP[hit.band] : undefined);
      } else {
        m.tipTarget = target;
        m.sel = hit.ti;
        schedule();
        showFor(hit, e.clientX, e.clientY, true);
      }
      return;
    }
    const d = m.drag;
    m.drag = null;
    cv.current!.style.cursor = "";
    if (!d || d.moved) return;
    const { hit } = hitAt(e);
    if (hit.ti >= 0) {
      m.sel = hit.ti;
      open(m.tiles[hit.ti].key, hit.band >= 0 ? BAND_CHIP[hit.band] : undefined);
    }
  };

  const announceSel = () => {
    const m = s.current;
    if (m.sel < 0 || m.sel >= m.tiles.length) return;
    const p = live.current.projects[m.tiles[m.sel].index];
    setAnnounce(`${p.name}, ${fmt(p.live)} memories, ${pct(p.share, 0)} at risk, ${plural(p.openConflicts, "open conflict")}`);
    if (document.activeElement === cv.current) {
      const sc = tileScreen(m.tiles[m.sel], m.cam);
      const r = cv.current!.getBoundingClientRect();
      const x = r.left + clamp(sc.x + sc.w / 2, 10, m.W - 10);
      const y = r.top + clamp(sc.y + sc.h / 2, 10, m.H - 10);
      tip.current?.show(tileTip(p, live.current.query, live.current.hits?.get(p.key)), x, y);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    const m = s.current;
    if (!m.tiles.length) return;
    const dir = ARROWS.get(e.key);
    if (dir) {
      e.preventDefault();
      const [dx, dy] = dir;
      const cur = m.tiles[Math.max(0, m.sel)];
      const cx = cur.x + cur.w / 2;
      const cy = cur.y + cur.h / 2;
      let best = -1;
      let bestScore = Infinity;
      m.tiles.forEach((t, i) => {
        if (i === m.sel) return;
        const along = (t.x + t.w / 2 - cx) * dx + (t.y + t.h / 2 - cy) * dy;
        if (along <= 1) return;
        const across = Math.abs((t.x + t.w / 2 - cx) * dy + (t.y + t.h / 2 - cy) * dx);
        const score = along + across * 2.5;
        if (score < bestScore) {
          bestScore = score;
          best = i;
        }
      });
      if (best >= 0) {
        m.sel = best;
        memory.current.selKey = m.tiles[best].key;
        const sc = tileScreen(m.tiles[best], m.cam);
        if (sc.x < 0 || sc.y < 0 || sc.x + sc.w > m.W || sc.y + sc.h > m.H) {
          m.cam = clampCam({ ...m.cam, x: m.cam.x + m.W / 2 - (sc.x + sc.w / 2), y: m.cam.y + m.H / 2 - (sc.y + sc.h / 2) }, m.W, m.H);
        }
        announceSel();
        schedule();
      }
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (m.sel >= 0) open(m.tiles[m.sel].key);
    } else if (e.key === "+" || e.key === "=") {
      setCam(zoomAt(m.cam, 1.4, m.W / 2, m.H / 2, m.W, m.H));
    } else if (e.key === "-") {
      setCam(zoomAt(m.cam, 1 / 1.4, m.W / 2, m.H / 2, m.W, m.H));
    } else if (e.key === "0") {
      m.tween?.();
      m.tween = tweenCam(m.cam, HOME_CAMERA, 220, m.W, m.H, setCam);
    }
  };

  const onFocus = () => {
    const m = s.current;
    if (m.sel < 0 && m.tiles.length) {
      m.sel = 0;
      memory.current.selKey = m.tiles[0].key;
    }
    announceSel();
    schedule();
  };

  return (
    <div ref={wrap} className="map-wrap">
      <canvas
        ref={cv}
        tabIndex={0}
        role="application"
        aria-roledescription="treemap"
        aria-label="Treemap of projects. The Table view lists the same numbers."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          s.current.drag = null;
          s.current.tap = null;
        }}
        onPointerLeave={() => {
          const m = s.current;
          if (m.hover !== -1) {
            m.hover = -1;
            schedule();
          }
          if (!m.tipTarget) tip.current?.hide();
        }}
        onFocus={onFocus}
        onBlur={() => {
          if (!s.current.tipTarget) tip.current?.hide();
        }}
        onKeyDown={onKeyDown}
      />
      <div className="sr-only" aria-live="polite" data-testid="treemap-live">
        {announce}
      </div>
    </div>
  );
}
