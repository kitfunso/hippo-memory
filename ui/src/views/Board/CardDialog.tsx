import { useEffect, useRef, useState } from "react";
import type { Card, CardDetail } from "../../types.js";
import { fetchCardDetail, errorMessage } from "../../api/client.js";
import { isLeaseExpired } from "./lease.js";

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

/** A card's status, runs, comments, deps and latest handoff, in a non-modal side panel. */
export function CardDialog({ cardId, refreshKey, onClose }: CardDialogProps) {
  const [detail, setDetail] = useState<CardDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const escRef = useRef<HTMLButtonElement>(null);

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
    <div role="dialog" aria-label="Card details" style={panelStyle}>
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
          <div style={errorTextStyle}>{error}</div>
        ) : (
          <div role="status" style={loadingTextStyle}>loading card</div>
        )}
      </div>
    </div>
  );
}

// Starts under the 48px board bar so its refresh button stays clickable with a card open.
const panelStyle: React.CSSProperties = {
  position: "absolute", top: 48, right: 0, width: "min(360px, 48vw)", height: "calc(100% - 48px)",
  background: "var(--glass-bg-strong)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)",
  borderLeft: "1px solid var(--glass-border)", overflowY: "auto", zIndex: 50,
};

const headerRowStyle: React.CSSProperties = {
  padding: "20px 24px 16px", borderBottom: "1px solid var(--glass-border)",
  display: "flex", justifyContent: "space-between", alignItems: "flex-start",
};

const statusLabelStyle: React.CSSProperties = {
  color: "var(--dim)", fontSize: 10, fontFamily: "var(--font-mono)", letterSpacing: "0.5px", textTransform: "uppercase",
};

const escButtonStyle: React.CSSProperties = {
  background: "var(--ink-faint)", border: "none", borderRadius: 4,
  color: "var(--dim)", cursor: "pointer", padding: "4px 10px", fontSize: 11, fontFamily: "var(--font-mono)",
};

const bodyStyle: React.CSSProperties = { padding: "20px 24px" };

const contentTitleStyle: React.CSSProperties = {
  color: "var(--text)", fontSize: 13, lineHeight: 1.7, whiteSpace: "pre-wrap", wordBreak: "break-word",
  fontFamily: "var(--font-body)", marginBottom: 20,
};

const gridStyle: React.CSSProperties = {
  display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 20px", fontSize: 11, marginBottom: 20,
};

const gridLabelStyle: React.CSSProperties = {
  color: "var(--dim)", fontSize: 9, fontFamily: "var(--font-mono)", textTransform: "uppercase",
  letterSpacing: "0.5px", marginBottom: 2,
};

const gridValueStyle: React.CSSProperties = {
  color: "var(--text)", fontFamily: "var(--font-mono)", wordBreak: "break-word",
};

const sectionBodyStyle: React.CSSProperties = {
  color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 11, wordBreak: "break-word",
};

const footerStyle: React.CSSProperties = {
  fontSize: 10, color: "var(--text-faint)", fontFamily: "var(--font-mono)",
  borderTop: "1px solid var(--glass-border)", paddingTop: 12, wordBreak: "break-word",
};

const errorTextStyle: React.CSSProperties = {
  color: "var(--red)", fontFamily: "var(--font-mono)", fontSize: 11,
};

const loadingTextStyle: React.CSSProperties = {
  color: "var(--dim)", fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "2px",
};

const expiredDotStyle: React.CSSProperties = {
  display: "inline-block",
  width: 8,
  height: 8,
  borderRadius: "50%",
  background: "var(--accent)",
  boxShadow: "0 0 8px var(--accent-focus)",
  verticalAlign: "middle",
};
