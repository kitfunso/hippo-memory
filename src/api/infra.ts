// The api's one door to src/infra: a Context names its outside services, or gets the real ones.
import type { InfraPorts } from '../base/ports/infra.js';
import { realInfra } from '../infra/ports.js';
import type { ConfiguredFolder } from '../domain/search/embed-memories.js';
import type { GlobalTargetGroup, StoreWith } from '../store/port.js';
import type { Context } from './types.js';

// A recall names its reranker; the registry holds each one's real transport and model for the process's life.
export { getReranker } from '../infra/rerankers.js';

/** A Context an integrator built without ports gets the real ones, as it did before ports existed. */
export function infraOf(ctx: Pick<Context, 'infra'>): InfraPorts {
  return ctx.infra ?? realInfra();
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
