import { useEffect, useId, useRef } from "react";
import { ApiError, errorMessage, fetchMemory } from "../../api/client";
import { SheetHandle } from "../../components/SheetHandle";
import { useBodyScrollLock, useFocusTrap } from "../../hooks/useModalSheet";
import { useIsPhone } from "../../hooks/useMediaQuery";
import { navigate } from "../../router";
import type { MemoryDetail } from "../../types";
import { useActions } from "./actions";
import { fmt } from "./format";
import { useHealth } from "./HealthContext";
import { LayerMark } from "./LayerMark";
import { usePanelCore } from "./usePanel";

/** Toast shown when a memory link points at a memory that no longer exists. */
export const DEAD_MEMORY_NOTICE = "That memory was forgotten or merged";

/** Help under the Pin button. */
export const PIN_HELP = "Pinned memories never decay. If pinned injection is on, they are added to every prompt.";

const BAND_LABEL = { pinned: "pinned band", strong: "strong", fading: "fading", atRisk: "at risk" };

function Fields({ d }: { d: MemoryDetail }) {
  const rows: [string, string][] = [
    ["Strength now", d.strength.toFixed(2)],
    ["In 7 days", d.strength7d.toFixed(2)],
    ["In 30 days", d.strength30d.toFixed(2)],
    ["Half-life", `${fmt(d.halfLifeDays)} days`],
    ["Retrievals", fmt(d.retrievals)],
    ["Last retrieved", d.lastRetrieved.slice(0, 10)],
    ["Created", d.created.slice(0, 10)],
    ["Age", `${fmt(d.ageDays)} days`],
    ["Schema fit", d.schemaFit.toFixed(2)],
    ["Valence", d.valence],
    ["Confidence", d.confidence],
    ["Project", d.projectName],
    ["Scope", d.scope ?? "none"],
    ["Tenant", d.tenant],
    ["Kind", d.kind],
    ["Embedded", d.embedded ? "yes" : "no"],
    ["Tags", d.tags.length ? d.tags.join(", ") : "none"],
  ];
  return (
    <dl className="dr-f">
      {rows.map(([k, v]) => (
        <div key={k} className="dr-pair">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Props of the memory drawer. */
export interface MemoryDrawerProps {
  projectKey: string;
  /** The memory to show, or null when the drawer is closed. */
  memoryId: string | null;
  onClose: () => void;
}

/** Memory detail and actions: a side panel on desktop that leaves the table usable, a modal bottom sheet on phones. */
export function MemoryDrawer({ projectKey, memoryId, onClose }: MemoryDrawerProps) {
  const { clock } = useHealth();
  const actions = useActions();
  const phone = useIsPhone();
  const open = memoryId !== null;
  const sheet = useRef<HTMLElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const wasOpen = useRef(false);
  const dead = useRef<string | null>(null);
  const titleId = useId();

  const load = ({ signal }: { signal: AbortSignal }) =>
    fetchMemory(memoryId ?? "", { signal }).catch((err: Error) => {
      if (err instanceof ApiError && err.status === 404) dead.current = memoryId;
      throw err;
    });
  const panel = usePanelCore<MemoryDetail>(clock, load, `memory:${memoryId}`, open);
  const missing = panel.error !== null && open && dead.current === memoryId;
  const { notify } = actions;

  useEffect(() => {
    if (!missing) return;
    navigate({ view: "health", projectKey, memoryId: null }, { replace: true });
    notify(DEAD_MEMORY_NOTICE);
  }, [missing, projectKey, notify]);

  useEffect(() => {
    if (open && !wasOpen.current) title.current?.focus();
    wasOpen.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (e.target instanceof Element && e.target.closest("[role=combobox]")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useFocusTrap(sheet, open && phone);
  useBodyScrollLock(open && phone);

  const d = panel.data;
  const ov = d ? actions.overlay.get(d.id) : undefined;
  const pinned = d ? (ov?.pinned ?? d.pinned) : false;
  const wrong = d ? d.wrong || ov?.wrong === true : false;

  return (
    <aside ref={sheet} className={open ? "drawer open" : "drawer"} role="dialog" aria-modal={phone && open} aria-labelledby={titleId} aria-hidden={!open} inert={!open}>
      {phone && <SheetHandle onClose={onClose} />}
      <div className="dr-h">
        <h2 id={titleId} ref={title} tabIndex={-1}>
          Memory <span className="mono">{memoryId}</span>
        </h2>
        <button type="button" className="icon-btn" aria-label="Close memory" onClick={onClose}>
          &times;
        </button>
      </div>
      <div className="dr-b">
        {open && !d && !panel.error && <p role="status">Loading memory</p>}
        {open && !d && panel.error && !missing && (
          <div role="alert">
            <p>{errorMessage(panel.error)}</p>
            <button type="button" className="btn" onClick={panel.reload}>
              Retry
            </button>
          </div>
        )}
        {d && (
          <>
            <p className="dr-content">{d.content}</p>
            <div className="dr-flags">
              <span>
                <LayerMark layer={d.layer} />
                {d.layer}
              </span>
              <span>{BAND_LABEL[d.band]}</span>
              {pinned && <span>pinned</span>}
              {wrong && <span>wrong</span>}
              {d.agedOut && <span>aged out</span>}
              {!d.embedded && <span>not embedded</span>}
            </div>
            <div className="dr-act">
              <button type="button" className="btn" aria-pressed={pinned} onClick={() => actions.pin(d.id, !pinned, projectKey)}>
                {pinned ? "Unpin" : "Pin"}
              </button>
              <button type="button" className="btn" disabled={wrong} onClick={() => actions.markWrong(d.id, projectKey)}>
                Mark wrong
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={() => {
                  actions.forget(d.id, projectKey);
                  onClose();
                }}
              >
                Forget
              </button>
            </div>
            <p className="muted">{PIN_HELP}</p>
            {d.conflicts.map((c) =>
              ov?.resolved && actions.overlay.get(c.other.id)?.resolved ? null : (
                <div key={c.id} className="cfbox">
                  <h3>Conflicts with another memory</h3>
                  <p className="oth">{c.other.content}</p>
                  <p className="why">
                    {c.reason} · score {c.score.toFixed(2)} · other strength {c.other.strength.toFixed(2)}, {fmt(c.other.retrievals)} uses
                  </p>
                  <div className="row">
                    <button type="button" className="btn sm" onClick={() => actions.resolve(c.id, d.id, c.other.id, projectKey)}>
                      Keep this one
                    </button>
                    <button type="button" className="btn sm" onClick={() => actions.resolve(c.id, c.other.id, d.id, projectKey)}>
                      Keep the other
                    </button>
                    <button type="button" className="btn sm quiet" onClick={() => navigate({ view: "health", projectKey, memoryId: c.other.id })}>
                      View the other
                    </button>
                  </div>
                </div>
              ),
            )}
            <Fields d={d} />
          </>
        )}
      </div>
    </aside>
  );
}
