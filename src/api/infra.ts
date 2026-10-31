// How the api reads the outside services: from the Context's ports, which its composition root or
// published entry set.
import type { RerankerFn } from '../base/ports/reranker.js';
import type { Context } from './types.js';

/** The reranker `name` picks from the Context's registry; a blank name picks none and an unknown
 * one throws. */
export function rerankerOf(
  ctx: Pick<Context, 'infra'>,
  name: string | null | undefined,
): RerankerFn | null {
  if (!name) return null;
  const lookup = ctx.infra.reranker;
  if (lookup === undefined) {
    throw new Error(`Unknown reranker: ${name}. This Context's infra names no rerankers`);
  }
  return lookup(name);
}
