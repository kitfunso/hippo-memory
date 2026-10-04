import type { DecayOutlook } from "../../types";
import { fmt, plural } from "./format";

const BUCKETS = ["Strong", "Fading", "At risk"];
const FILL = ["#2f6fed", "#f29256", "#b5451b"];

function Row({ label, counts }: { label: string; counts: readonly [number, number, number] }) {
  const sum = counts[0] + counts[1] + counts[2];
  return (
    <>
      <div className="rl">{label}</div>
      <div className="dbar" aria-hidden="true">
        {counts.map((n, i) => (
          <i key={BUCKETS[i]} style={{ width: `${sum ? (n / sum) * 100 : 0}%`, background: FILL[i] }} />
        ))}
      </div>
      {counts.map((n, i) => (
        <div key={BUCKETS[i]} className="nv">
          {fmt(n)}
        </div>
      ))}
    </>
  );
}

/** How many memories sit in each strength band now and after 7 and 30 days without use, for the filtered set. */
export function DecayCard({ decay }: { decay: DecayOutlook | null }) {
  const more = decay ? Math.max(0, decay.in30d[2] - decay.now[2]) : 0;
  return (
    <section className="card decay" aria-label="Decay outlook">
      <h2 className="decay-h">Decay outlook</h2>
      {decay === null ? (
        <span className="skel skel-row" aria-busy="true" />
      ) : (
        <>
          <div className="dgrid">
            <span />
            <span />
            {BUCKETS.map((b) => (
              <span key={b} className="hd">
                {b}
              </span>
            ))}
            <Row label="Now" counts={decay.now} />
            <Row label="In 7 days" counts={decay.in7d} />
            <Row label="In 30 days" counts={decay.in30d} />
          </div>
          <p className="dnote">
            Without use, <b>{plural(more, "more memory", "more memories")}</b> would be at risk in 30 days. <b>{fmt(decay.pinned)}</b> pinned never decay.
          </p>
        </>
      )}
    </section>
  );
}
