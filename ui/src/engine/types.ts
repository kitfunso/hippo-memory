/**
 * Engine-internal types. LAYER_COLORS re-exported from the single source of
 * truth at ui/src/tokens.ts (the parchment palette per hybrid-v4 revamp E1).
 */

export interface Particle {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  color: string;
  opacity: number;
  layer: "buffer" | "episodic" | "semantic";
  strength: number;
  pulsePhase: number;
  selected: boolean;
}

export { LAYER_COLORS, LAYER_COLORS_HEX } from "../tokens.js";
