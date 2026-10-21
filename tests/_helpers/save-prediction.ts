import { BadRequestError } from '../../src/base/errors/api-errors.js';
import { loadConfig } from '../../src/base/config/config.js';
import { assertTenantId } from '../../src/base/scope/tenant-id.js';
import { predictionMirror } from '../../src/base/records/prediction.js';
import type { Prediction, SavePredictionOptions } from '../../src/store/port/predictions.js';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { handlesOf } from '../../src/store/sqlite/handles.js';

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
  return sqliteSyncStore(handlesOf(hippoRoot)).predictions.savePrediction(tenantId, { ...opts, mirror }, actor);
}
