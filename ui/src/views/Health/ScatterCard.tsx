import { useId, useState } from "react";
import { ALL_LAYERS } from "../../api/client";
import { useHasTouch } from "../../hooks/useMediaQuery";
import type { ProjectDetail } from "../../types";
import { BrushFields } from "./BrushFields";
import { type Brush, densityRgb, scatterSummary } from "./canvas/scatter";
import { fmt } from "./format";
import { LayerMark } from "./LayerMark";
import { ScatterCanvas } from "./ScatterCanvas";

const RAMP = `linear-gradient(90deg, rgb(${densityRgb(0).join(",")}), rgb(${densityRgb(1).join(",")}))`;

/** Props of the scatter card: the project payload, the layer and brush filters, and the open memory. */
export interface ScatterCardProps {
  detail: ProjectDetail;
  layerOn: readonly boolean[];
  onLayer: (index: number) => void;
  brush: Brush | null;
  brushRev: number;
  /** A brush drawn on the canvas, or null to clear it. */
  onDragBrush: (brush: Brush | null) => void;
  /** A brush typed into the number inputs. */
  onFieldBrush: (brush: Brush | null) => void;
  /** Rows the brush selects. */
  selected: number;
  openId: string | null;
  onOpen: (id: string) => void;
}

/** The age and strength scatter with its layer toggles, the touch Brush toggle and the number-input filter. */
export function ScatterCard(props: ScatterCardProps) {
  const { detail, layerOn, onLayer, brush, brushRev, onDragBrush, onFieldBrush, selected, openId, onOpen } = props;
  const { summary, scatter } = detail;
  const [brushOn, setBrushOn] = useState(false);
  const touch = useHasTouch();
  const summaryId = useId();
  return (
    <section className="card" aria-labelledby={`${summaryId}-h`}>
      <div className="card-h">
        <h2 id={`${summaryId}-h`}>Age and strength</h2>
        <span className="spacer" />
        {ALL_LAYERS.map((layer, i) => (
          <button key={layer} type="button" className="tog layer" aria-pressed={layerOn[i]} onClick={() => onLayer(i)}>
            <LayerMark layer={layer} />
            {layer} <span className="n">{fmt(summary.layers[layer])}</span>
          </button>
        ))}
        {touch && (
          <button type="button" className="tog" aria-pressed={brushOn} onClick={() => setBrushOn(!brushOn)}>
            Brush
          </button>
        )}
      </div>
      <p id={summaryId} className="sr-only">
        {scatterSummary(summary, scatter.maxAgeDays)}
      </p>
      <ScatterCanvas
        data={scatter}
        on={layerOn}
        brush={brush}
        selected={selected}
        openId={openId}
        brushOn={brushOn}
        onBrush={onDragBrush}
        onBrushDone={() => setBrushOn(false)}
        onOpen={onOpen}
        describedBy={summaryId}
      />
      <div className="sc-foot">
        {scatter.mode === "grid" ? (
          <span className="lg tight">
            <span className="dens-ramp" style={{ background: RAMP }} aria-hidden="true" />
            darker = more memories
          </span>
        ) : (
          <span className="lg tight">ringed = pinned</span>
        )}
        <details className="sc-filter">
          <summary>Filter by age and strength</summary>
          <BrushFields brush={brush} rev={brushRev} maxAgeDays={scatter.maxAgeDays} onChange={onFieldBrush} />
          {brush && (
            <button type="button" className="btn quiet" onClick={() => onDragBrush(null)}>
              Clear filter
            </button>
          )}
        </details>
      </div>
    </section>
  );
}
