import { BadRequestError } from '../../src/core/api-errors.js';
import { loadConfig } from '../../src/core/config.js';
import { assertTenantId } from '../../src/core/tenant-id.js';
import { handlesOf, openStore } from '../../src/store/open.js';
import { predictionMirror, writePredictionAt } from '../../src/store/predictions.js';
import type { Prediction, SavePredictionOptions } from '../../src/store/port/predictions.js';

/** A prediction with its recall mirror, the mirror's half-life read from the store's config.json as the CLI would. */
export function savePrediction(
  hippoRoot: string,
  tenantId: string,
  opts: SavePredictionOptions,
  actor: string = 'cli',
): Prediction {
  assertTenantId('savePrediction', tenantId);
  if (!opts.classTag) throw new BadRequestError('savePrediction: classTag is required');
  if (!opts.claimText) throw new BadRequestError('savePrediction: claimText is required');

  const mirror = predictionMirror(tenantId, opts, loadConfig(hippoRoot).defaultHalfLifeDays);
  return handlesOf(hippoRoot).on((db, files) => writePredictionAt(db, files, tenantId, { ...opts, mirror }, actor), openStore);
}
