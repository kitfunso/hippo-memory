import { BadRequestError } from '../../src/core/api-errors.js';
import { loadConfig } from '../../src/core/config.js';
import { assertTenantId } from '../../src/store/tenant.js';
import { predictionMirror, writePrediction, type Prediction, type SavePredictionOpts } from '../../src/store/predictions.js';

/** A prediction with its recall mirror, the mirror's half-life read from the store's config.json as the CLI would. */
export function savePrediction(
  hippoRoot: string,
  tenantId: string,
  opts: SavePredictionOpts,
  actor: string = 'cli',
): Prediction {
  assertTenantId('savePrediction', tenantId);
  if (!opts.classTag) throw new BadRequestError('savePrediction: classTag is required');
  if (!opts.claimText) throw new BadRequestError('savePrediction: claimText is required');

  const mirror = predictionMirror(tenantId, opts, loadConfig(hippoRoot).defaultHalfLifeDays);
  return writePrediction(hippoRoot, tenantId, { ...opts, mirror }, actor);
}
