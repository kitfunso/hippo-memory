import { BadRequestError } from '../../src/core/api-errors.js';
import { loadConfig } from '../../src/core/config.js';
import { assertTenantId } from '../../src/core/tenant-id.js';
import { predictionMirror } from '../../src/core/prediction.js';
import type { Prediction, SavePredictionOptions } from '../../src/store/port/predictions.js';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';

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
  return sqliteSyncStore(hippoRoot).predictions.savePrediction(tenantId, { ...opts, mirror }, actor);
}
