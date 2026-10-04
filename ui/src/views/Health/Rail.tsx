import type { Overview, ProjectSummary } from "../../types";
import { BAND_NAME, BAND_RGB } from "./canvas/riskColor";
import { fmt, pct, plural, projectLabel } from "./format";

interface RailProps {
  data: Overview | null;
  onOpen: (key: string) => void;
}

function Item({ p, meta, onOpen }: { p: ProjectSummary; meta: string; onOpen: (key: string) => void }) {
  const name = projectLabel(p);
  return (
    <button type="button" className="ra" title={name} onClick={() => onOpen(p.key)}>
      <span className="nm ell">{name}</span>
      <span className="mt">{meta}</span>
      <span className="chev" aria-hidden="true">
        &rsaquo;
      </span>
    </button>
  );
}

/** Legend plus the projects most at risk and with the most open conflicts. */
export function Rail({ data, onOpen }: RailProps) {
  const byKey = new Map((data?.projects ?? []).map((p) => [p.key, p]));
  const pick = (keys: readonly string[] | undefined) => (keys ?? []).flatMap((k) => byKey.get(k) ?? []);
  const risky = pick(data?.mostAtRisk).filter((p) => p.atRisk > 0);
  const conflicted = pick(data?.mostConflicts).filter((p) => p.openConflicts > 0);
  return (
    <aside className="card rail" aria-label="Legend and projects that need attention">
      <section>
        <h3>Colour = at-risk share</h3>
        <div className="ramp" aria-hidden="true" />
        <div className="ramp-t" aria-hidden="true">
          <span>0%</span>
          <span>20%</span>
          <span>40%</span>
          <span>60%+</span>
        </div>
        <div className="lg">
          <span className="sw hatch" aria-hidden="true" />
          Hatched corner = open conflicts
        </div>
        <div className="lg">
          <span className="muted">Area = memory count. Zoom in to see each strength band:</span>
        </div>
        <div className="lg-grid">
          {BAND_NAME.map((name, i) => (
            <div key={name} className="lg tight">
              <span className="sw" style={{ background: `rgb(${BAND_RGB[i]})` }} aria-hidden="true" />
              {name}
            </div>
          ))}
        </div>
      </section>
      <section>
        <h3>Most at risk</h3>
        {data === null ? (
          <div className="skel skel-row" aria-hidden="true" />
        ) : risky.length > 0 ? (
          risky.map((p) => <Item key={p.key} p={p} meta={`${fmt(p.atRisk)} · ${pct(p.share, 0)}`} onOpen={onOpen} />)
        ) : (
          <p className="muted">Nothing at risk.</p>
        )}
      </section>
      <section>
        <h3>Most conflicts</h3>
        {data === null ? (
          <div className="skel skel-row" aria-hidden="true" />
        ) : conflicted.length > 0 ? (
          conflicted.map((p) => <Item key={p.key} p={p} meta={plural(p.openConflicts, "pair")} onOpen={onOpen} />)
        ) : (
          <p className="muted">No open conflicts.</p>
        )}
      </section>
    </aside>
  );
}
