import type { Memory } from "../types.js";
import type { Particle } from "./types.js";
import { LAYER_COLORS } from "./types.js";
import {
  COLOR_ACCENT_DIM,
  COLOR_BG_GRADIENT_INNER,
  COLOR_BG_GRADIENT_MID,
  COLOR_BG_GRADIENT_OUTER,
  COLOR_BUFFER,
  COLOR_EPISODIC,
  COLOR_SEMANTIC,
} from "../tokens.js";

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function rgba(r: number, g: number, b: number, a: number): string {
  return `rgba(${r},${g},${b},${a})`;
}

function colorAlpha(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgba(r, g, b, a);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export class ParticleEngine {
  particles: Particle[] = [];
  private highlightedIds: Set<string> = new Set();
  private searchDimmed = false;
  private hoveredId: string | null = null;
  private frameCount = 0;
  private width = 0;
  private height = 0;
  private driftOffsets: Map<string, { dx: number; dy: number; phase: number; speed: number }> =
    new Map();

  initialize(
    memories: Memory[],
    positions: Record<string, [number, number]>,
    width: number,
    height: number,
  ): void {
    this.width = width;
    this.height = height;
    this.driftOffsets.clear();

    const maxRetrieval = memories.reduce((max, m) => Math.max(max, m.retrieval_count), 1);
    const logMax = Math.log2(maxRetrieval + 1);
    const padX = 40;
    const padY = 40;
    const usableW = width - padX * 2;
    const usableH = height - padY * 2;

    this.particles = memories.map((m) => {
      const pos = positions[m.id];
      const x = pos ? padX + ((pos[0] + 1) / 2) * usableW : padX + Math.random() * usableW;
      const y = pos ? padY + ((pos[1] + 1) / 2) * usableH : padY + Math.random() * usableH;
      const logRatio = Math.log2(m.retrieval_count + 1) / logMax;
      const radius = 4 + logRatio * 14;

      this.driftOffsets.set(m.id, {
        dx: (Math.random() - 0.5) * 2,
        dy: (Math.random() - 0.5) * 1.5,
        phase: Math.random() * Math.PI * 2,
        speed: 0.0003 + Math.random() * 0.0005,
      });

      return {
        id: m.id,
        x,
        y,
        vx: 0,
        vy: 0,
        radius,
        color: LAYER_COLORS[m.layer],
        opacity: 0.2 + m.strength * 0.8,
        layer: m.layer,
        strength: m.strength,
        pulsePhase: Math.random() * Math.PI * 2,
        selected: false,
      };
    });
  }

  hitTest(px: number, py: number): Particle | null {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      const dx = px - p.x;
      const dy = py - p.y;
      const r = p.radius + 6;
      if (dx * dx + dy * dy <= r * r) return p;
    }
    return null;
  }

  setHighlighted(ids: Set<string>): void {
    this.highlightedIds = ids;
    this.searchDimmed = true;
  }

  clearHighlight(): void {
    this.highlightedIds = new Set();
    this.searchDimmed = false;
  }

  setHovered(id: string | null): void {
    this.hoveredId = id;
  }

  private renderDeep(ctx: CanvasRenderingContext2D, w: number, h: number, time: number): void {
    const bg = ctx.createRadialGradient(w * 0.5, h * 0.45, 0, w * 0.5, h * 0.45, Math.max(w, h) * 0.75);
    // Parchment bg gradient (inner brightest, outer warm parchment)
    bg.addColorStop(0, COLOR_BG_GRADIENT_INNER);
    bg.addColorStop(0.6, COLOR_BG_GRADIENT_MID);
    bg.addColorStop(1, COLOR_BG_GRADIENT_OUTER);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    const driftT = time * 0.00008;
    ctx.fillStyle = "rgba(255,255,255,0.03)";
    const spacing = 60;
    for (let gx = 0; gx < w + spacing; gx += spacing) {
      for (let gy = 0; gy < h + spacing; gy += spacing) {
        const ox = Math.sin(gy * 0.01 + driftT) * 3;
        const oy = Math.cos(gx * 0.01 + driftT * 0.7) * 3;
        ctx.beginPath();
        ctx.arc(gx + ox, gy + oy, 0.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (this.frameCount % 4 === 0) {
      const seed = Math.floor(time / 80);
      const rng = this.mulberry32(seed);
      ctx.fillStyle = "rgba(255,255,255,0.008)";
      for (let i = 0; i < 150; i++) {
        ctx.fillRect(rng() * w, rng() * h, 1, 1);
      }
    }
  }

  private mulberry32(seed: number): () => number {
    let s = seed | 0;
    return () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  private renderTendrils(ctx: CanvasRenderingContext2D, time: number): void {
    const n = this.particles.length;
    if (n > 500) return;

    const maxDist = 140;
    const maxDistSq = maxDist * maxDist;

    for (let i = 0; i < n; i++) {
      const a = this.particles[i];
      if (this.searchDimmed && !this.highlightedIds.has(a.id)) continue;

      for (let j = i + 1; j < n; j++) {
        const b = this.particles[j];
        if (this.searchDimmed && !this.highlightedIds.has(b.id)) continue;

        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const distSq = dx * dx + dy * dy;
        if (distSq > maxDistSq) continue;

        const dist = Math.sqrt(distSq);
        const fade = 1 - dist / maxDist;
        const alpha = fade * fade * 0.09;

        const [r1, g1, b1] = hexToRgb(a.color);
        const [r2, g2, b2] = hexToRgb(b.color);
        const mr = Math.round(lerp(r1, r2, 0.5));
        const mg = Math.round(lerp(g1, g2, 0.5));
        const mb = Math.round(lerp(b1, b2, 0.5));

        const wave = Math.sin(time * 0.001 + i * 0.3 + j * 0.17) * 8;
        const midX = (a.x + b.x) / 2 + wave * (dy / (dist + 1));
        const midY = (a.y + b.y) / 2 - wave * (dx / (dist + 1));

        ctx.strokeStyle = rgba(mr, mg, mb, alpha);
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(midX, midY, b.x, b.y);
        ctx.stroke();
      }
    }
  }

  private renderZones(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = "10px 'JetBrains Mono', monospace";

    // Zones use the parchment layer tints with low alpha. Tints come from
    // tokens.ts so any future palette change cascades here automatically.
    const zones: [number, string, string][] = [
      [0.18, "BUFFER", colorAlpha(COLOR_BUFFER, 0.12)],
      [0.50, "EPISODIC", colorAlpha(COLOR_EPISODIC, 0.12)],
      [0.82, "SEMANTIC", colorAlpha(COLOR_SEMANTIC, 0.12)],
    ];

    for (const [yFrac, label, color] of zones) {
      const y = yFrac * h;
      ctx.fillStyle = color;

      const spaced = label.split("").join("  ");
      ctx.fillText(spaced, 24, y);

      ctx.strokeStyle = color;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      const textWidth = ctx.measureText(spaced).width;
      ctx.moveTo(24 + textWidth + 12, y);
      ctx.lineTo(w - 24, y);
      ctx.stroke();
    }
  }

  renderConflicts(
    ctx: CanvasRenderingContext2D,
    conflicts: Array<{ memory_a_id: string; memory_b_id: string; score: number }>,
  ): void {
    const particleMap = new Map<string, Particle>();
    for (const p of this.particles) particleMap.set(p.id, p);

    for (const c of conflicts) {
      const a = particleMap.get(c.memory_a_id);
      const b = particleMap.get(c.memory_b_id);
      if (!a || !b) continue;

      const alpha = 0.15 + c.score * 0.4;
      const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      grad.addColorStop(0, colorAlpha(COLOR_ACCENT_DIM, alpha * 0.3));
      grad.addColorStop(0.5, colorAlpha(COLOR_ACCENT_DIM, alpha));
      grad.addColorStop(1, colorAlpha(COLOR_ACCENT_DIM, alpha * 0.3));

      ctx.save();
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1 + c.score * 0.8;
      ctx.setLineDash([3, 6]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
    }
  }

  render(
    ctx: CanvasRenderingContext2D,
    time: number,
    conflicts?: Array<{ memory_a_id: string; memory_b_id: string; score: number }>,
  ): void {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    this.frameCount++;

    this.renderDeep(ctx, w, h, time);
    this.renderZones(ctx, w, h);
    this.renderTendrils(ctx, time);

    if (conflicts && conflicts.length > 0) {
      this.renderConflicts(ctx, conflicts);
    }

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      const drift = this.driftOffsets.get(p.id);
      let px = p.x;
      let py = p.y;
      if (drift) {
        px += Math.sin(time * drift.speed + drift.phase) * drift.dx * 3;
        py += Math.cos(time * drift.speed * 0.8 + drift.phase) * drift.dy * 3;
      }

      const isDimmed = this.searchDimmed && !this.highlightedIds.has(p.id);
      const isMatch = this.searchDimmed && this.highlightedIds.has(p.id);
      const isHovered = p.id === this.hoveredId;
      const baseOpacity = isDimmed ? p.opacity * 0.04 : p.opacity;

      let drawRadius = p.radius;
      if (p.selected) drawRadius *= 1 + 0.12 * Math.sin(time * 0.003 + p.pulsePhase);
      if (isHovered) drawRadius *= 1.35;

      const breathe = 1 + 0.05 * Math.sin(time * 0.0015 + p.pulsePhase);
      const finalOpacity = baseOpacity * breathe;

      if (isDimmed) {
        ctx.fillStyle = colorAlpha(p.color, finalOpacity);
        ctx.beginPath();
        ctx.arc(px, py, drawRadius * 0.7, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }

      const [cr, cg, cb] = hexToRgb(p.color);

      const haloR = drawRadius * (isHovered ? 5 : isMatch ? 4.5 : 3.5);
      const haloAlpha = finalOpacity * (isHovered ? 0.18 : isMatch ? 0.15 : 0.1);
      const halo = ctx.createRadialGradient(px, py, drawRadius * 0.3, px, py, haloR);
      halo.addColorStop(0, rgba(cr, cg, cb, haloAlpha));
      halo.addColorStop(0.4, rgba(cr, cg, cb, haloAlpha * 0.4));
      halo.addColorStop(1, rgba(cr, cg, cb, 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(px, py, haloR, 0, Math.PI * 2);
      ctx.fill();

      const bodyGrad = ctx.createRadialGradient(
        px - drawRadius * 0.2,
        py - drawRadius * 0.2,
        0,
        px,
        py,
        drawRadius,
      );
      bodyGrad.addColorStop(0, rgba(
        Math.min(255, cr + 60),
        Math.min(255, cg + 60),
        Math.min(255, cb + 60),
        finalOpacity * 0.95,
      ));
      bodyGrad.addColorStop(0.6, rgba(cr, cg, cb, finalOpacity * 0.85));
      bodyGrad.addColorStop(1, rgba(
        Math.max(0, cr - 30),
        Math.max(0, cg - 30),
        Math.max(0, cb - 30),
        finalOpacity * 0.6,
      ));
      ctx.fillStyle = bodyGrad;
      ctx.beginPath();
      ctx.arc(px, py, drawRadius, 0, Math.PI * 2);
      ctx.fill();

      const coreR = drawRadius * 0.3;
      const coreGrad = ctx.createRadialGradient(
        px - drawRadius * 0.1,
        py - drawRadius * 0.15,
        0,
        px,
        py,
        coreR * 2,
      );
      coreGrad.addColorStop(0, `rgba(255,255,255,${0.5 * finalOpacity})`);
      coreGrad.addColorStop(0.5, `rgba(255,255,255,${0.15 * finalOpacity})`);
      coreGrad.addColorStop(1, `rgba(255,255,255,0)`);
      ctx.fillStyle = coreGrad;
      ctx.beginPath();
      ctx.arc(px - drawRadius * 0.1, py - drawRadius * 0.15, coreR * 2, 0, Math.PI * 2);
      ctx.fill();

      if (drawRadius > 5) {
        ctx.strokeStyle = `rgba(255,255,255,${0.12 * finalOpacity})`;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.arc(px, py, drawRadius - 0.5, -0.85 * Math.PI, -0.15 * Math.PI);
        ctx.stroke();
      }

      if (isHovered) {
        ctx.save();
        ctx.strokeStyle = `rgba(255,255,255,${0.25 * finalOpacity})`;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.arc(px, py, drawRadius + 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      if (p.selected) {
        const ringPulse = 1 + 0.08 * Math.sin(time * 0.004 + p.pulsePhase);
        const ringR = (drawRadius + 5) * ringPulse;
        ctx.strokeStyle = `rgba(255,255,255,${0.4 * finalOpacity})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(px, py, ringR, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = colorAlpha(p.color, 0.15 * finalOpacity);
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.arc(px, py, ringR + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
}
