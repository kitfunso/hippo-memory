// The token ledger's write for memory text handed to an agent.

import { rethrowIfStoreBlocked } from '../base/util/store-blocked.js';
import type { TokenSurface } from '../base/records/ledger.js';
import { errorMessage, log, errorFields } from '../base/util/log.js';
import type { Context } from './types.js';

/** Records memory text handed to an agent in the token ledger. Best-effort: never throws, since
 * a ledger failure must not fail the recall or context call. */
export async function recordTokens(
  ctx: Context,
  surface: TokenSurface,
  use: { items: number; tokens: number; sessionId?: string | null },
): Promise<void> {
  try {
    await ctx.store.recordTokens({
      tenantId: ctx.tenantId,
      sessionId: use.sessionId ?? null,
      surface,
      event: 'inject',
      items: use.items,
      tokens: use.tokens,
    });
  } catch (err) {
    rethrowIfStoreBlocked(err);
    log.warnThenDebug(
      'api-token-ledger',
      `token ledger write failed; the reply is unaffected: ${errorMessage(err)}`,
      errorFields(err),
    );
  }
}
