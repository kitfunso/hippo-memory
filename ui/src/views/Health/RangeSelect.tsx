import { type Range, useHealth } from "./HealthContext";

const RANGES: readonly Range[] = [7, 30, 90];

const toRange = (value: string): Range => RANGES.find((r) => String(r) === value) ?? 30;

/** The date-range select; the header holds it on desktop and the KPI strip on phones, never both. */
export function RangeSelect() {
  const { range, setRange } = useHealth();
  return (
    <>
      <label className="sr-only" htmlFor="range">
        Date range
      </label>
      <select id="range" className="ctl range" value={range} onChange={(e) => setRange(toRange(e.target.value))}>
        {RANGES.map((r) => (
          <option key={r} value={r}>
            Last {r} days
          </option>
        ))}
      </select>
    </>
  );
}
