import { useEffect, useRef, useState } from "react";
import type { Card, CardStatus } from "../../types.js";
import { fetchCards, errorMessage } from "../../api/client.js";
import { isLeaseExpired } from "./lease.js";
import { CardDialog } from "./CardDialog.js";
import { BOARD_TOOLBAR_H } from "./layout.js";

export { BOARD_TOOLBAR_H };

const STATUSES: readonly CardStatus[] = ["backlog", "ready", "running", "blocked", "review", "done", "shelved"];

function formatLeaseTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function tileMeta(card: Card, now: number): React.ReactNode {
  if (card.status === "running") {
    if (isLeaseExpired(card, now)) {
      return (
        <>
          {card.assigneeRuntime} <span style={expiredDotStyle} />
          <span style={{ color: "var(--text)" }}> lease expired</span>
        </>
      );
    }
    if (card.leaseUntil !== null) {
      return <>{card.assigneeRuntime} lease until {formatLeaseTime(card.leaseUntil)}</>;
    }
  }
  return card.assigneeRuntime || null;
}

/** Every card in the work queue, laid out in one column per status (CONTEXT.md "Board"). */
export function Board() {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadCount, setLoadCount] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let ignore = false;
    fetchCards()
      .then((result) => {
        if (ignore) return;
        setCards(result.cards);
        setError(null);
        setLoading(false);
      })
      .catch((err) => {
        if (ignore) return;
        setError(errorMessage(err));
        setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [loadCount]);

  // Button never disabled during a fetch: disabling it would drop keyboard focus.
  function refresh() {
    setLoading(true);
    setLoadCount((n) => n + 1);
  }

  function closeDialog() {
    setSelectedId(null);
    if (selectedId !== null) {
      frameRef.current?.querySelector<HTMLElement>(`[data-card-id="${selectedId}"]`)?.focus();
    }
  }

  const now = Date.now();
  const total = cards?.length ?? 0;

  return (
    <div style={containerStyle}>
      <h1 className="sr-only">Card board</h1>
      <div style={barStyle}>
        <span aria-live="polite" className="bar-live" style={{ color: "var(--text-3)", fontSize: 12, fontFamily: "var(--mono)" }}>
          {cards !== null ? `${total} ${total === 1 ? "card" : "cards"}` : ""}
        </span>
        <div style={{ flex: 1 }} />
        {cards !== null && error !== null && (
          <span role="alert" style={{ color: "var(--risk)", fontSize: 12, fontFamily: "var(--mono)" }}>
            {error}
          </span>
        )}
        <button type="button" onClick={refresh} style={refreshButtonStyle}>
          {loading ? "refreshing" : "refresh"}
        </button>
      </div>

      <div ref={frameRef} style={frameStyle}>
        {cards === null && error === null && (
          <div style={frameCenterStyle}>
            <div role="status" style={loadingTextStyle}>loading cards</div>
          </div>
        )}
        {cards === null && error !== null && (
          <div style={frameCenterStyle}>
            <div role="alert" style={errorTextStyle}>{error}</div>
            <div style={hintTextStyle}>is hippo dashboard running?</div>
          </div>
        )}
        {cards !== null && cards.length === 0 && (
          <div style={frameCenterStyle}>
            <div style={emptyTextStyle}>no cards yet</div>
            <div style={hintTextStyle}>
              run <span style={{ color: "var(--accent)" }}>hippo card create</span> to begin
            </div>
          </div>
        )}
        {cards !== null && cards.length > 0 && STATUSES.map((status) => {
          const inColumn = cards.filter((c) => c.status === status);
          return (
            <section key={status} aria-labelledby={`board-col-${status}`} style={columnStyle}>
              <h3 id={`board-col-${status}`} style={columnTitleStyle}>
                {status} <span style={columnCountStyle}>{inColumn.length}</span>
              </h3>
              <ul style={columnListStyle}>
                {inColumn.length === 0 ? (
                  <li style={noneStyle}>none</li>
                ) : (
                  inColumn.map((card) => {
                    const meta = tileMeta(card, now);
                    return (
                      <li key={card.id}>
                        <button
                          type="button"
                          data-card-id={card.id}
                          onClick={() => setSelectedId(card.id)}
                          style={{
                            ...tileStyle,
                            background: card.id === selectedId ? "var(--accent-weak)" : "transparent",
                            borderColor: card.id === selectedId ? "var(--accent)" : "var(--line)",
                          }}
                        >
                          <div style={tileTitleStyle}>{card.title}</div>
                          <div style={tileIdStyle}>{card.id}</div>
                          {meta && <div style={tileMetaStyle}>{meta}</div>}
                        </button>
                      </li>
                    );
                  })
                )}
              </ul>
            </section>
          );
        })}
      </div>

      {/* ponytail: no per-column cap or virtualisation; add one when the board sees a few hundred cards. */}
      {selectedId && <CardDialog key={selectedId} cardId={selectedId} refreshKey={loadCount} onClose={closeDialog} />}
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  width: "100%", height: "100%", position: "relative", display: "flex", flexDirection: "column",
};

const barStyle: React.CSSProperties = {
  height: BOARD_TOOLBAR_H, flex: "0 0 auto",
  background: "var(--surface)",
  borderBottom: "1px solid var(--line)",
  padding: "0 16px", gap: 12,
  display: "flex", alignItems: "center",
};

const frameStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  margin: 16,
  border: "1px solid var(--line-2)",
  borderRadius: 2,
  background: "var(--surface)",
  display: "flex",
  gap: 12,
  padding: 16,
  overflowX: "auto",
};

const refreshButtonStyle: React.CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 12,
  textTransform: "uppercase",
  background: "transparent",
  border: "1px solid var(--line)",
  color: "var(--text-3)",
  padding: "5px 12px",
  minHeight: 44,
  borderRadius: 4,
  cursor: "pointer",
  transition: "color 150ms ease, border-color 150ms ease, background 150ms ease",
};

const frameCenterStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  textAlign: "center",
};

const loadingTextStyle: React.CSSProperties = {
  color: "var(--text-3)",
  fontFamily: "var(--mono)",
  fontSize: 12,
  letterSpacing: "2px",
};

const errorTextStyle: React.CSSProperties = {
  color: "var(--risk)",
  fontFamily: "var(--mono)",
  fontSize: 12,
  marginBottom: 8,
};

const emptyTextStyle: React.CSSProperties = {
  color: "var(--text-3)",
  fontSize: 12,
  fontFamily: "var(--mono)",
  marginBottom: 8,
};

const hintTextStyle: React.CSSProperties = {
  color: "var(--text-3)",
  fontSize: 12,
  fontFamily: "var(--mono)",
};

const columnStyle: React.CSSProperties = {
  flex: "1 0 180px",
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
};

const columnTitleStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 400,
  color: "var(--text)",
  marginBottom: 4,
  paddingBottom: 6,
  borderBottom: "1px solid var(--line)",
};

const columnCountStyle: React.CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 12,
  color: "var(--text-3)",
};

const columnListStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const noneStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-3)",
  fontStyle: "italic",
  fontFamily: "var(--sans)",
};

const tileStyle: React.CSSProperties = {
  display: "block",
  padding: "8px 10px",
  background: "transparent",
  border: "1px solid var(--line)",
  borderRadius: 3,
  cursor: "pointer",
  transition: "background 150ms ease",
  width: "100%",
  textAlign: "left",
};

const tileTitleStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.5,
  color: "var(--text)",
  fontFamily: "var(--sans)",
  marginBottom: 4,
};

const tileIdStyle: React.CSSProperties = {
  marginBottom: 4,
  color: "var(--text-3)",
  fontFamily: "var(--mono)",
  fontSize: 12,
  wordBreak: "break-word",
};

const tileMetaStyle: React.CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 12,
  color: "var(--text-3)",
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
