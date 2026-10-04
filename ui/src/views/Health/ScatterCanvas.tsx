import { type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ALL_LAYERS } from "../../api/client";
import type { ScatterGrid, ScatterPoints } from "../../types";
import { type Brush, type CellHit, type Plot, brushFromDrag, drawOverlay, drawScatter, hitCell, hitPoint, maxLogFor } from "./canvas/scatter";
import { fmt, plural } from "./format";
import { useHealth } from "./HealthContext";

const TAP_SLOP = 10;
const DRAG_SLOP = 4;
const BAND_LABEL = ["pinned", "strong", "fading", "at risk"];

type Data = ScatterPoints | ScatterGrid;

interface Probe {
  /** Stable name of what is under the pointer; a second touch tap on the same target opens it. */
  target: string | null;
  index: number;
  cell: CellHit | null;
}

const NONE: Probe = { target: null, index: -1, cell: null };

function probe(data: Data, on: readonly boolean[], plot: Plot, mx: number, my: number): Probe {
  if (data.mode === "points") {
    const k = hitPoint(data, on, plot, mx, my);
    return k < 0 ? NONE : { target: `pt:${k}`, index: k, cell: null };
  }
  const cell = hitCell(data, on, plot, mx, my);
  return cell && cell.count > 0 ? { target: `cell:${cell.col}:${cell.row}`, index: -1, cell } : NONE;
}

function tipFor(data: Data, p: Probe): ReactNode {
  if (data.mode === "points") {
    const [age, strength, layer, band] = data.points[p.index];
    return (
      <>
        <b>{ALL_LAYERS[layer]}</b> · {BAND_LABEL[band]}
        <div className="m">
          strength {strength.toFixed(2)} · age {fmt(age)} days
        </div>
        <div className="m">{data.ids[p.index]}</div>
      </>
    );
  }
  const c = p.cell;
  if (!c) return null;
  return (
    <>
      <b>{plural(c.count, "memory", "memories")}</b>
      <div className="m">
        age {fmt(c.age0)} to {fmt(c.age1)} days
      </div>
      <div className="m">
        strength {c.s0.toFixed(2)} to {c.s1.toFixed(2)}
      </div>
    </>
  );
}

function pointAt(data: Data, k: number): readonly [number, number] | null {
  if (data.mode !== "points" || k < 0 || k >= data.points.length) return null;
  return [data.points[k][0], data.points[k][1]];
}

/** Props of the scatter canvases: data, what is on, the brush and the open memory. */
export interface ScatterCanvasProps {
  data: Data;
  on: readonly boolean[];
  brush: Brush | null;
  /** Rows the brush selects, drawn on the brush. */
  selected: number;
  openId: string | null;
  /** Touch brush mode: a drag draws the brush instead of scrolling the page. */
  brushOn: boolean;
  onBrush: (brush: Brush | null) => void;
  /** A touch brush drag ended. */
  onBrushDone: () => void;
  onOpen: (id: string) => void;
  describedBy: string;
}

/** Scatter of age against strength: points or density cells, hover tip, mouse and touch brush, tap-to-open. */
export function ScatterCanvas({ data, on, brush, selected, openId, brushOn, onBrush, onBrushDone, onOpen, describedBy }: ScatterCanvasProps) {
  const { tip } = useHealth();
  const wrap = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLCanvasElement>(null);
  const over = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ W: 0, H: 0 });
  const [hover, setHover] = useState(-1);
  const [cell, setCell] = useState<CellHit | null>(null);
  const g = useRef<{ drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null; tap: { x: number; y: number } | null; tipTarget: string | null }>({
    drag: null,
    tap: null,
    tipTarget: null,
  });
  const dpr = window.devicePixelRatio || 1;
  const plot = useMemo<Plot>(() => ({ W: size.W, H: size.H, maxLog: maxLogFor(data) }), [size, data]);

  const measure = useCallback(() => {
    const r = wrap.current?.getBoundingClientRect();
    if (!r) return;
    const W = Math.round(r.width);
    const H = Math.round(r.height);
    setSize((s) => (s.W === W && s.H === H ? s : { W, H }));
  }, []);

  useLayoutEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [measure]);

  const hideTip = useCallback(() => {
    g.current.tipTarget = null;
    tip.current?.hide();
  }, [tip]);

  useEffect(() => {
    const ctx = base.current?.getContext("2d");
    if (ctx) drawScatter(ctx, { plot, dpr, data, on });
  }, [plot, dpr, data, on]);

  const openIndex = data.mode === "points" && openId !== null ? data.ids.indexOf(openId) : -1;
  useEffect(() => {
    const ctx = over.current?.getContext("2d");
    if (ctx) drawOverlay(ctx, { plot, dpr, brush, open: pointAt(data, openIndex), hover: pointAt(data, hover), cell, selected });
  }, [plot, dpr, brush, data, openIndex, hover, cell, selected]);

  useEffect(() => {
    setHover(-1);
    setCell(null);
    hideTip();
  }, [data, hideTip]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const inside = e.target instanceof Element && e.target.closest("canvas, .tip");
      if (g.current.tipTarget && !inside) hideTip();
    };
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      hideTip();
    };
  }, [hideTip]);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = over.current?.getBoundingClientRect();
    return { mx: e.clientX - (r?.left ?? 0), my: e.clientY - (r?.top ?? 0) };
  };

  const clearHover = () => {
    setHover(-1);
    setCell(null);
  };

  const activate = (p: Probe) => {
    if (data.mode === "points") onOpen(data.ids[p.index]);
    else if (p.cell) onBrush({ a0: p.cell.age0, a1: p.cell.age1, s0: p.cell.s0, s1: p.cell.s1 });
  };

  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const touch = e.pointerType === "touch";
    if (touch && !brushOn) {
      g.current.tap = { x: e.clientX, y: e.clientY };
      return;
    }
    if (!touch && e.button !== 0) return;
    const { mx, my } = local(e);
    over.current?.setPointerCapture?.(e.pointerId);
    g.current.drag = { x: mx, y: my, cx: e.clientX, cy: e.clientY, moved: false };
  };

  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const touch = e.pointerType === "touch";
    if (touch && !brushOn) return;
    const { mx, my } = local(e);
    const d = g.current.drag;
    if (d && (d.moved || Math.hypot(e.clientX - d.cx, e.clientY - d.cy) > DRAG_SLOP)) {
      d.moved = true;
      hideTip();
      clearHover();
      onBrush(brushFromDrag(plot, d.x, d.y, mx, my));
      return;
    }
    if (touch) return;
    const p = probe(data, on, plot, mx, my);
    setHover(p.index);
    setCell(p.cell);
    if (p.target) tip.current?.show(tipFor(data, p), e.clientX, e.clientY);
    else tip.current?.hide();
  };

  const onTap = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const tap = g.current.tap;
    g.current.tap = null;
    if (!tap || Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > TAP_SLOP) return;
    const { mx, my } = local(e);
    const p = probe(data, on, plot, mx, my);
    if (!p.target) {
      hideTip();
      clearHover();
    } else if (g.current.tipTarget === p.target) {
      hideTip();
      clearHover();
      activate(p);
    } else {
      g.current.tipTarget = p.target;
      setHover(p.index);
      setCell(p.cell);
      const onClose = () => {
        g.current.tipTarget = null;
        clearHover();
      };
      tip.current?.show(tipFor(data, p), e.clientX, e.clientY, { closable: true, onClose });
    }
  };

  const onUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const touch = e.pointerType === "touch";
    if (touch && !brushOn) {
      onTap(e);
      return;
    }
    const d = g.current.drag;
    g.current.drag = null;
    if (!d) return;
    if (d.moved) {
      if (touch) onBrushDone();
      return;
    }
    if (touch) return;
    const { mx, my } = local(e);
    const p = probe(data, on, plot, mx, my);
    if (p.target) activate(p);
    else if (brush) onBrush(null);
  };

  const onCancel = () => {
    g.current.tap = null;
    g.current.drag = null;
  };

  return (
    <div ref={wrap} className="sc-wrap" role="img" aria-label="Memory age against strength" aria-describedby={describedBy}>
      <canvas ref={base} width={Math.round(size.W * dpr)} height={Math.round(size.H * dpr)} aria-hidden="true" />
      <canvas
        ref={over}
        className={brushOn ? "ov brushing" : "ov"}
        width={Math.round(size.W * dpr)}
        height={Math.round(size.H * dpr)}
        aria-hidden="true"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onCancel}
        onPointerLeave={(e) => {
          if (e.pointerType === "touch" || g.current.drag) return;
          clearHover();
          tip.current?.hide();
        }}
      />
    </div>
  );
}
