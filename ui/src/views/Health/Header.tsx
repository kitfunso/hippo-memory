import { useEffect, useState } from "react";
import { ViewSwitch, type View } from "../../components/ViewSwitch";
import { navigate, useRoute } from "../../router";
import { keyLabel, projectLabel, relSince } from "./format";
import { type Range, useHealth } from "./HealthContext";
import { SearchBox } from "./SearchBox";

const RANGES: readonly Range[] = [7, 30, 90];

const toRange = (value: string): Range => RANGES.find((r) => String(r) === value) ?? 30;
const TICK_MS = 15_000;

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}

function Crumbs() {
  const route = useRoute();
  const { overview } = useHealth();
  if (route.view !== "health") return null;
  const key = route.projectKey;
  const project = key === null ? undefined : overview.data?.projects.find((p) => p.key === key);
  const name = key === null ? "" : project ? projectLabel(project) : keyLabel(key);
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <ol>
        {key === null ? (
          <li>
            <span className="cur ell" aria-current="page">
              All projects
            </span>
          </li>
        ) : (
          <>
            <li>
              <button type="button" onClick={() => navigate({ view: "health", projectKey: null, memoryId: null })}>
                All projects
              </button>
            </li>
            {route.memoryId !== null ? (
              <>
                <li>
                  <button type="button" className="ell" title={name} onClick={() => navigate({ view: "health", projectKey: key, memoryId: null })}>
                    {name}
                  </button>
                </li>
                <li>
                  <span className="cur ell mono" aria-current="page">
                    {route.memoryId}
                  </span>
                </li>
              </>
            ) : (
              <li>
                <span className="cur ell" aria-current="page" title={name}>
                  {name}
                </span>
              </li>
            )}
          </>
        )}
      </ol>
    </nav>
  );
}

interface HeaderProps {
  view: View;
  onViewChange: (view: View) => void;
  autoFocusSwitch: boolean;
}

/** Shared header: brand, then (Health only) crumbs, search, range; the view switch, Updated and Refresh sit at the right. */
export function Header({ view, onViewChange, autoFocusSwitch }: HeaderProps) {
  const { overview, range, setRange, refresh, refreshing } = useHealth();
  const now = useNow();
  const health = view === "health";
  return (
    <header className="top">
      <div className="brand">
        <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
          <rect x="1" y="1" width="9" height="12" rx="1.5" fill="#2f6fed" />
          <rect x="12" y="1" width="9" height="7" rx="1.5" fill="#9db8f3" />
          <rect x="12" y="10" width="9" height="11" rx="1.5" fill="#2f6fed" opacity=".55" />
          <rect x="1" y="15" width="9" height="6" rx="1.5" fill="#e8590c" />
        </svg>
        <span>hippo</span>
        <small>Memory</small>
      </div>
      {health ? <Crumbs /> : <span className="spacer" />}
      {health && <SearchBox />}
      {health && (
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
      )}
      <div className="top-right">
        <ViewSwitch view={view} onChange={onViewChange} autoFocus={autoFocusSwitch} />
        {health && overview.data && <span className="updated">Updated {relSince(overview.data.generatedAt, now)}</span>}
        {health && (
          <button type="button" className="btn" aria-label="Refresh" aria-busy={refreshing} onClick={refresh}>
            {refreshing ? "Refreshing" : "Refresh"}
          </button>
        )}
      </div>
      <span className="top-break" aria-hidden="true" />
    </header>
  );
}
