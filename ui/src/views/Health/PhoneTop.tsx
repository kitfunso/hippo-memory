import { useEffect, useState } from "react";
import { navigate } from "../../router";
import { relSince } from "./format";
import { useHealth } from "./HealthContext";

const TICK_MS = 15_000;

interface PhoneTopProps {
  projectKey: string;
  name: string;
  memoryId: string | null;
}

/** Phone only: the crumbs and the Updated label as the first line of the project view, where the header no longer holds them. */
export function PhoneTop({ projectKey, name, memoryId }: PhoneTopProps) {
  const { overview } = useHealth();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  const generatedAt = overview.data?.generatedAt;
  return (
    <div className="pv-top">
      <nav className="crumbs" aria-label="Breadcrumb">
        <ol>
          <li>
            <button type="button" onClick={() => navigate({ view: "health", projectKey: null, memoryId: null })}>
              All projects
            </button>
          </li>
          {memoryId !== null ? (
            <>
              <li>
                <button type="button" className="ell" title={name} onClick={() => navigate({ view: "health", projectKey, memoryId: null })}>
                  {name}
                </button>
              </li>
              <li>
                <span className="cur ell mono" aria-current="page">
                  {memoryId}
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
        </ol>
      </nav>
      {generatedAt && <span className="updated">Updated {relSince(generatedAt, now)}</span>}
    </div>
  );
}
