// The token ledger's surfaces and retention, once for both adapters.
import { DAY_MS } from '../../base/util/time.js';
import type { TokenSurface } from '../port/ledger.js';

/** Every surface a block is sent on, in report order. */
export const TOKEN_SURFACES: readonly TokenSurface[] = [
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

/** Surfaces whose re-reads are counted: only a hook payload tells a sub-agent's block from its parent's, as both carry
 * one session id. */
export const REREAD_SURFACES: readonly TokenSurface[] = ['hook', 'hook_recall', 'compact_resume'];

/** Rows older than this are pruned on write. */
const TOKEN_LEDGER_RETENTION_DAYS = 90;

/** The stamp a row written at `ts` prunes before: {@link TOKEN_LEDGER_RETENTION_DAYS} earlier. */
export const ledgerCutoff = (ts: string): string =>
  new Date(Date.parse(ts) - TOKEN_LEDGER_RETENTION_DAYS * DAY_MS).toISOString();
