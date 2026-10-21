// The in-memory token ledger: the base recordTokens write and the reports group's tokenUse summary.
import { DAY_MS } from '../../base/util/time.js';
import type { TokenSummary, TokenSurface, TokenSurfaceSummary, TokenUse } from '../port/ledger.js';
import { byBytes } from '../rules/order.js';
import { nextId } from './rows.js';
import type { TokenRow } from './session-tables.js';
import type { MemoryTables } from './tables.js';

// Copied from hippo.db's adapter, where neither list is exported: every surface in report order, and the hook
// surfaces whose re-reads are counted.
const TOKEN_SURFACES: readonly TokenSurface[] = [
  'hook',
  'hook_recall',
  'compact_resume',
  'context',
  'recall',
  'mcp_recall',
  'mcp_context',
  'http_recall',
  'http_context',
  'http_assemble',
];
const REREAD_SURFACES: readonly TokenSurface[] = ['hook', 'hook_recall', 'compact_resume'];
const TOKEN_LEDGER_RETENTION_DAYS = 90;

/** One ledger row, then every row past the retention window from its timestamp goes. */
export function recordTokensIn(t: MemoryTables, use: TokenUse): void {
  const ts = use.now ?? new Date().toISOString();
  t.tokenLedger.push({
    id: nextId(t, 'token_ledger'),
    ts,
    tenantId: use.tenantId,
    sessionId: use.sessionId ?? null,
    surface: use.surface,
    event: use.event,
    blockHash: use.hash ?? null,
    items: Math.max(0, Math.round(use.items)),
    tokens: Math.max(0, Math.round(use.tokens)),
  });
  const cutoff = new Date(Date.parse(ts) - TOKEN_LEDGER_RETENTION_DAYS * DAY_MS).toISOString();
  t.tokenLedger = t.tokenLedger.filter((row) => byBytes(row.ts, cutoff) >= 0);
}

const tokensOf = (rows: readonly TokenRow[], event: TokenRow['event']): number =>
  rows.reduce((sum, row) => sum + (row.event === event ? row.tokens : 0), 0);

/** COUNT(DISTINCT session_id): a null session id is not counted. */
const distinctSessions = (rows: readonly TokenRow[]): number =>
  new Set(rows.flatMap((row) => (row.sessionId === null ? [] : [row.sessionId]))).size;

function surfaceSummary(surface: TokenSurface, rows: readonly TokenRow[]): TokenSurfaceSummary {
  return {
    surface,
    injected: rows.filter((row) => row.event === 'inject').length,
    tokens: tokensOf(rows, 'inject'),
    skipped: rows.filter((row) => row.event === 'skip').length,
    tokensAvoided: tokensOf(rows, 'skip'),
    tokensReread: tokensOf(rows, 'reread'),
    sessions: distinctSessions(rows),
  };
}

/** The tenant's ledger since `sinceIso`; surfaces with no rows are left out. */
export function tokenUseIn(t: MemoryTables, tenantId: string, sinceIso: string): TokenSummary {
  const window = t.tokenLedger.filter((row) => row.tenantId === tenantId && byBytes(row.ts, sinceIso) >= 0);
  const surfaces = TOKEN_SURFACES.flatMap((surface) => {
    const rows = window.filter((row) => row.surface === surface);
    return rows.length === 0 ? [] : [surfaceSummary(surface, rows)];
  });
  const sessionRows = window.filter((row) => row.sessionId !== null && row.event !== 'arm');
  const sessions = distinctSessions(sessionRows);
  const hookRows = sessionRows.filter((row) => row.event !== 'reset' && REREAD_SURFACES.includes(row.surface));
  return {
    since: sinceIso,
    surfaces,
    totalTokens: surfaces.reduce((s, x) => s + x.tokens, 0),
    totalTokensAvoided: surfaces.reduce((s, x) => s + x.tokensAvoided, 0),
    totalTokensReread: surfaces.reduce((s, x) => s + x.tokensReread, 0),
    meanTokensPerSession: sessions > 0 ? Math.round(tokensOf(sessionRows, 'inject') / sessions) : 0,
    sessions,
    hookSessions: distinctSessions(hookRows),
    rereadSessions: distinctSessions(sessionRows.filter((row) => row.event === 'reread')),
  };
}
