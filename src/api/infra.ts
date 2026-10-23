// How the api reads the outside services: from the Context's ports, which its composition root or published entry set.
import type { RerankerFn } from '../base/ports/reranker.js';
import type { ConfiguredFolder } from '../domain/search/embed-memories.js';
import type { GlobalTargetGroup, StoreWith } from '../store/port.js';
import type { Context } from './types.js';

/** The reranker `name` picks from the Context's registry; a blank name picks none and an unknown one throws. */
export function rerankerOf(ctx: Pick<Context, 'infra'>, name: string | null | undefined): RerankerFn | null {
  if (!name) return null;
  const lookup = ctx.infra.reranker;
  if (lookup === undefined) throw new Error(`Unknown reranker: ${name}. This Context's infra names no rerankers`);
  return lookup(name);
}

/** The reach's global write target with an embedder filled in: the host's own, else the context's. */
export function globalTargetOf(
  ctx: Pick<Context, 'reach' | 'infra'>,
): ConfiguredFolder<StoreWith<GlobalTargetGroup>> | undefined {
  const target = ctx.reach?.globalTarget;
  return (
    target && {
      ...target,
      embedderFor: target.embedderFor ?? ctx.infra.embedderFor,
    }
  );
}
