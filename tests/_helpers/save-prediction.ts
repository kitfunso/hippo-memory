import { BadRequestError } from '../../src/base/errors/api-errors.js';
import { loadConfig } from '../../src/host/config-file.js';
import { assertTenantId } from '../../src/base/scope/tenant-id.js';
import { predictionMirror } from '../../src/base/records/prediction.js';
import type { Prediction, SavePredictionOptions } from '../../src/base/records/objects.js';
import { sqliteStore } from './test-session.js';
import { evalNow } from '../../src/infra/eval-switches.js';

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

  const mirror = predictionMirror(tenantId, opts, loadConfig(hippoRoot).defaultHalfLifeDays, evalNow());
  return await sqliteStore(hippoRoot).hippoDb.objects.saveObject(tenantId, 'prediction', { ...opts, mirror, actor });
}
