import { ALL_LAYERS } from "../../api/client";
import type { Layer } from "../../types";
import { LAYER_COL } from "./canvas/scatter";

/** Wire index of a layer: the scatter, the toggles and the table all share it. */
export const layerIndex = (layer: Layer): number => ALL_LAYERS.indexOf(layer);

/** Layer mark: square, circle, triangle or diamond, so colour is never the only cue. */
export function LayerMark({ layer, size = 10 }: { layer: Layer; size?: number }) {
  const i = layerIndex(layer);
  const col = LAYER_COL[i];
  const r = size / 2;
  const c = size / 2;
  const mark =
    i === 0 ? (
      <rect x={c - r * 0.78} y={c - r * 0.78} width={r * 1.56} height={r * 1.56} fill={col} />
    ) : i === 1 ? (
      <circle cx={c} cy={c} r={r} fill={col} />
    ) : i === 2 ? (
      <polygon points={`${c},${c - r} ${c + 1.75 * r * 0.62},${c + r * 0.75} ${c - 1.75 * r * 0.62},${c + r * 0.75}`} fill={col} />
    ) : (
      <polygon points={`${c},${c - r} ${c + r},${c} ${c},${c + r} ${c - r},${c}`} fill={col} />
    );
  return (
    <svg className="shape" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      {mark}
    </svg>
  );
}
