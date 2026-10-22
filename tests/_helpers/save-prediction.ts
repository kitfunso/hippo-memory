import { BadRequestError } from '../../src/base/errors/api-errors.js';
import { loadConfig } from '../../src/host/config-file.js';
import { assertTenantId } from '../../src/base/scope/tenant-id.js';
import { predictionMirror } from '../../src/base/records/prediction.js';
import type { Prediction, SavePredictionOptions } from '../../src/store/port/objects.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';

/** A prediction with its recall mirror, the mirror's half-life read from the store's config.json as the CLI would. */
export async function savePrediction(
  hippoRoot: string,
  tenantId: string,
  opts: SavePredictionOptions,
  actor: string = 'cli',
): Promise<Prediction> {
  assertTenantId('savePrediction', tenantId);
  if (!opts.classTag) throw new BadRequestError('savePrediction: classTag is required');
  if (!opts.claimText) throw new BadRequestError('savePrediction: claimText is required');

  const mirror = predictionMirror(tenantId, opts, loadConfig(hippoRoot).defaultHalfLifeDays);
  return await sqliteStore(hippoRoot).predictions.savePrediction(tenantId, { ...opts, mirror }, actor);
}
