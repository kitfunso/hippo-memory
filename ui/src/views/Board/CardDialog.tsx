import { useEffect, useRef, useState } from "react";
import type { Card, CardDetail } from "../../types.js";
import { fetchCardDetail, errorMessage } from "../../api/client.js";
import { isLeaseExpired } from "./lease.js";
import { BOARD_TOOLBAR_H } from "./layout.js";
import { useIsPhone } from "../../hooks/useMediaQuery.js";
import { useFocusTrap, useBodyScrollLock } from "../../hooks/useModalSheet.js";
import { SheetHandle } from "../../components/SheetHandle.js";

interface CardDialogProps {
  cardId: string;
  refreshKey: number;
  onClose: () => void;
}

function renderLeaseGridValue(card: Card, now: number): React.ReactNode {
  if (isLeaseExpired(card, now)) {
    return (
      <>
        <span style={expiredDotStyle} /> expired
      </>
    );
  }
  if (card.leaseUntil !== null) {
    return `until ${new Date(card.leaseUntil).toLocaleString()}`;
  }
  return null;
}

function GridRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div style={gridLabelStyle}>{label}</div>
      <div style={gridValueStyle}>{value}</div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={gridLabelStyle}>{label}</div>
      <div style={sectionBodyStyle}>{children}</div>
    </div>
  );
}

/** A card's status, runs, comments, deps and latest handoff: a non-modal side panel, a modal bottom sheet on phones. */
export function CardDialog({ cardId, refreshKey, onClose }: CardDialogProps) {
  const [detail, setDetail] = useState<CardDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const escRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const phone = useIsPhone();
  useFocusTrap(panelRef, phone);
  useBodyScrollLock(phone);

  useEffect(() => {
    let ignore = false;
    setError(null);
    fetchCardDetail(cardId)
      .then((result) => {
        if (!ignore) setDetail(result);
      })
      .catch((err) => {
        if (!ignore) setError(errorMessage(err));
      });
    return () => {
      ignore = true;
    };
  }, [cardId, refreshKey]);

  useEffect(() => {
    escRef.current?.focus();
  }, []);

  // Nothing else in board view listens for Escape, so a plain window listener is enough.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const now = Date.now();

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Card details"
      aria-modal={phone ? true : undefined}
      style={phone ? sheetStyle : panelStyle}
    >
      {phone && <SheetHandle onClose={onClose} />}
      <div style={headerRowStyle}>
        <span style={statusLabelStyle}>{detail?.card.status ?? ""}</span>
        <button ref={escRef} type="button" aria-label="esc, close card details" onClick={onClose} style={escButtonStyle}>
          esc
        </button>
      </div>
      <div style={bodyStyle}>
        {detail ? (
          <>
            {error !== null && (
              <div role="alert" style={errorTextStyle}>{error}</div>
            )}
            <div style={contentTitleStyle}>{detail.card.title}</div>
            <div style={gridStyle}>
              <GridRow label="Status" value={detail.card.status} />
              {detail.card.assigneeRuntime !== null && <GridRow label="Assignee" value={detail.card.assigneeRuntime} />}
              {detail.card.status === "running" && <GridRow label="Lease" value={renderLeaseGridValue(detail.card, now)} />}
              {detail.card.heartbeatAt !== null && <GridRow label="Heartbeat" value={new Date(detail.card.heartbeatAt).toLocaleString()} />}
              {detail.card.repo !== null && <GridRow label="Repo" value={detail.card.repo} />}
              {detail.card.budget !== null && <GridRow label="Budget" value={String(detail.card.budget)} />}
              <GridRow label="Updated" value={new Date(detail.card.updatedAt).toLocaleString()} />
            </div>
            {detail.card.contract !== null && (
              <Section label="Contract">
                <div style={{ whiteSpace: "pre-wrap" }}>{detail.card.contract}</div>
              </Section>
            )}
            {detail.deps.parents.length > 0 && <Section label="Parents">{detail.deps.parents.join(", ")}</Section>}
            {detail.deps.children.length > 0 && <Section label="Children">{detail.deps.children.join(", ")}</Section>}
            {detail.runs.length > 0 && (
              <Section label="Runs">
                {detail.runs.map((run) => (
                  <div key={run.id}>
                    run {run.id}: {run.runtime} started {new Date(run.started).toLocaleString()}
                    {run.ended !== null ? <> ended {new Date(run.ended).toLocaleString()} ({run.outcome})</> : " (open)"}
                  </div>
                ))}
              </Section>
            )}
            {detail.comments.length > 0 && (
              <Section label="Comments">
                {detail.comments.map((c) => (
                  <div key={c.id}>[{new Date(c.createdAt).toLocaleString()}] {c.author}: {c.body}</div>
                ))}
              </Section>
            )}
            {detail.handoff !== null && (
              <Section label="Latest handoff">
                <div>Session: {detail.handoff.sessionId}, updated {new Date(detail.handoff.updatedAt).toLocaleString()}</div>
                <div>{detail.handoff.summary}</div>
              </Section>
            )}
            <div style={footerStyle}>{detail.card.id}</div>
          </>
        ) : error ? (
          <div role="alert" style={errorTextStyle}>{error}</div>
        ) : (
          <div role="status" style={loadingTextStyle}>loading card</div>
        )}
      </div>
    </div>
  );
}

// Starts under the board toolbar so its refresh button stays clickable with a card open.
const panelStyle: React.CSSProperties = {
  position: "absolute", top: BOARD_TOOLBAR_H, right: 0, width: "min(360px, 48vw)", height: `calc(100% - ${BOARD_TOOLBAR_H}px)`,
  background: "var(--surface)",
  borderLeft: "1px solid var(--line)", overflowY: "auto", zIndex: 50,
};

const sheetStyle: React.CSSProperties = {
  position: "fixed", left: 0, right: 0, bottom: 0, top: "auto", width: "100%", maxHeight: "85vh",
  background: "var(--surface)", borderTop: "1px solid var(--line)", borderRadius: "12px 12px 0 0",
  overflowY: "auto", zIndex: 50,
};

const headerRowStyle: React.CSSProperties = {
  padding: "20px 24px 16px", borderBottom: "1px solid var(--line)",
  display: "flex", justifyContent: "space-between", alignItems: "flex-start",
};

const statusLabelStyle: React.CSSProperties = {
  color: "var(--text-3)", fontSize: 12, fontFamily: "var(--mono)", textTransform: "uppercase",
};

const escButtonStyle: React.CSSProperties = {
  background: "var(--bg)", border: "none", borderRadius: 4,
  color: "var(--text-3)", cursor: "pointer", padding: "4px 10px", fontSize: 12, fontFamily: "var(--mono)",
};

const bodyStyle: React.CSSProperties = { padding: "20px 24px" };

const contentTitleStyle: React.CSSProperties = {
  color: "var(--text)", fontSize: 13, lineHeight: 1.7, whiteSpace: "pre-wrap", wordBreak: "break-word",
  fontFamily: "var(--sans)", marginBottom: 20,
};

const gridStyle: React.CSSProperties = {
  display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 20px", fontSize: 12, marginBottom: 20,
};

const gridLabelStyle: React.CSSProperties = {
  color: "var(--text-3)", fontSize: 12, fontFamily: "var(--mono)", textTransform: "uppercase",
  marginBottom: 2,
};

const gridValueStyle: React.CSSProperties = {
  color: "var(--text)", fontFamily: "var(--mono)", wordBreak: "break-word",
};

const sectionBodyStyle: React.CSSProperties = {
  color: "var(--text)", fontFamily: "var(--mono)", fontSize: 12, wordBreak: "break-word",
};

const footerStyle: React.CSSProperties = {
  fontSize: 12, color: "var(--text-3)", fontFamily: "var(--mono)",
  borderTop: "1px solid var(--line)", paddingTop: 12, wordBreak: "break-word",
};

const errorTextStyle: React.CSSProperties = {
  color: "var(--risk)", fontFamily: "var(--mono)", fontSize: 12,
};

const loadingTextStyle: React.CSSProperties = {
  color: "var(--text-3)", fontFamily: "var(--mono)", fontSize: 12, letterSpacing: "2px",
};

const expiredDotStyle: React.CSSProperties = {
  display: "inline-block",
  width: 8,
  height: 8,
  borderRadius: "50%",
  background: "var(--accent)",
  boxShadow: "0 0 0 3px var(--accent-weak)",
  verticalAlign: "middle",
};
