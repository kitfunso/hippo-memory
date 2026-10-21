// The api's one door to src/infra: a Context names its outside services, or gets the real ones.
import type { InfraPorts } from '../base/ports/infra.js';
import { realInfra } from '../infra/ports.js';
import type { Context } from './types.js';

// A recall names its reranker; the registry holds each one's real transport and model for the process's life.
export { getReranker } from '../infra/rerankers.js';

/** A Context an integrator built without ports gets the real ones, as it did before ports existed. */
export function infraOf(ctx: Pick<Context, 'infra'>): InfraPorts {
  return ctx.infra ?? realInfra();
}
