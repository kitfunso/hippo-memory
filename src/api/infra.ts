// The api's one door to src/infra: a Context names its outside services, or gets the real ones.
import type { InfraPorts } from '../base/ports/infra.js';
import { realInfra } from '../infra/ports.js';
import type { Context } from './types.js';

/** A Context an integrator built without ports gets the real ones, as it did before ports existed. */
export function infraOf(ctx: Pick<Context, 'infra'>): InfraPorts {
  return ctx.infra ?? realInfra();
}
