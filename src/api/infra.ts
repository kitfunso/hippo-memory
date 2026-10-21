// How the api reads the outside services: from the Context's ports, which its composition root or published entry set.
import type { InfraPorts } from '../base/ports/infra.js';
import type { RerankerFn } from '../base/ports/reranker.js';
import type { ConfiguredFolder } from '../domain/search/embed-memories.js';
import type { GlobalTargetGroup, StoreWith } from '../store/port.js';
import type { Context } from './types.js';

/** The Context's ports; a Context that reaches the api without them was built past every root and entry. */
export function infraOf(ctx: Pick<Context, 'infra'>): InfraPorts {
  if (ctx.infra === undefined) {
    throw new Error('this Context has no infra: build it in a composition root or pass it through a published entry');
  }
  return ctx.infra;
}

/** The reranker `name` picks from the Context's registry; a blank name picks none and an unknown one throws. */
export function rerankerOf(ctx: Pick<Context, 'infra'>, name: string | null | undefined): RerankerFn | null {
  if (!name) return null;
  const lookup = infraOf(ctx).reranker;
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
      embedderFor: target.embedderFor ?? infraOf(ctx).embedderFor,
    }
  );
}
